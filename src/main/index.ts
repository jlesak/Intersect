import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  Notification,
  powerMonitor,
  shell,
  utilityProcess
} from 'electron'
import { Channel, type CoreStatus } from '@common/ipc'
import { effectiveAdoOrgUrl } from '@common/ado'
import type { AppSettings, LiveClaudeSession } from '@common/domain'
import {
  WINDOW_FOCUS_CHANGED,
  type CoreInitMessage,
  type NativeNotificationRequest
} from '@common/coreBridge'
import type { RpcPort } from '@common/portRpc'
import type { Logger } from '@common/logging/logger'
import { safeText } from '@common/logging/record'
import { createCoreHost, type CoreHost } from './coreHost'
import { registerCoreBridge } from './ipc/bridge'
import { createSystemHandlers } from './ipc/system.ipc'
import { appMenuTemplate } from './menu'
import {
  activateAction,
  createUnattendedShutdown,
  isUserPresenceInput,
  quitDecision,
  shouldConfirmQuit,
  shouldQuitOnWindowAllClosed,
  shouldZeroDockBadge
} from './lifecycle'
import {
  createMainLogger,
  createMainSink,
  installMainGlobalHandlers,
  pruneLogsOnStartup,
  registerRendererLogReceiver,
  resolveLogLevel
} from './logging'

/**
 * Electron main is a thin shell now: it owns windows, the Dock, dialogs, native
 * notifications, and openExternal - everything else lives in the headless core utility
 * process and is reached over the typed port bridge. Main never opens the database and
 * never spawns a PTY.
 */

// Deterministic userData dir -> ~/Library/Application Support/Intersect/ (or an E2E override).
app.setName('Intersect')

let mainWindow: BrowserWindow | null = null
let host: CoreHost | null = null
let coreStatus: CoreStatus = { state: 'starting' }
// Set by before-quit: the app is on its coordinated way out, so window lifecycle events must
// neither veto the quit nor create new windows.
let quitting = false
// Raised by the system's power-off signal: the machine is logging out, restarting or shutting
// down, so the quit that follows has nobody in front of it to answer the suspend confirmation.
// Withdrawn again by `markUserPresent`, because a power-off can be abandoned before it ever
// reaches this app and the claim has to expire with it.
const unattendedShutdown = createUnattendedShutdown()
// Assigned once the app is ready and the user data directory is known, which is the earliest
// moment a file-backed logger can exist. Every call site stays optional so a failure before that
// point cannot turn into a second failure inside the reporting itself.
let log: Logger | null = null

/** The one place the Dock badge is written: the count of sessions awaiting interaction. */
function setDockBadge(count: number): void {
  app.dock?.setBadge(count > 0 ? String(count) : '')
}

/**
 * Record that somebody is demonstrably at the machine, which withdraws any standing power-off
 * claim. Every call site is an act a shutdown sequence cannot perform on its own, so a logout that
 * was aborted before this app was asked to quit leaves the suspend confirmation armed.
 */
function markUserPresent(): void {
  if (unattendedShutdown.disarm()) {
    log?.info('user present after a signalled shutdown, the suspend confirmation is armed again')
  }
}

/** Fire-and-forget send to the renderer, guarded against a destroyed window. */
function sendToRenderer(channel: string, ...args: unknown[]): void {
  const wc = mainWindow?.webContents
  if (wc && !wc.isDestroyed()) wc.send(channel, ...args)
}

/**
 * Bring the app to the foreground from a background/minimised state (as when the user
 * clicks a session's notification) and hand the target session to the renderer to navigate to.
 */
function focusAndNavigate(sessionId: string): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
  app.focus({ steal: true })
  sendToRenderer(Channel.terminalNotificationClicked, { sessionId })
}

/**
 * Raise the native macOS notification the core asked for. The core already resolved the
 * session to its tab/workspace names; main only displays and wires the click. No-ops
 * silently where the OS cannot show notifications (e.g. an unsigned dev build).
 */
function showCoreNotification(request: NativeNotificationRequest): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({
    title: request.title,
    subtitle: request.subtitle,
    body: request.body,
    silent: request.silent
  })
  notification.on('click', () => focusAndNavigate(request.sessionId))
  // macOS (Electron 42+) only shows notifications for a code-signed app; an unsigned dev
  // build fires 'failed' instead of a banner. Log it so a missing banner is diagnosable.
  notification.on('failed', (_e, error) =>
    log?.error('native notification failed', {
      data: { sessionId: request.sessionId },
      err: error
    })
  )
  notification.show()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#171d28',
    title: 'Intersect',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
    host?.notify(WINDOW_FOCUS_CHANGED, [{ focused: false }])
  })

  // A key or button press inside the window is a person, and a shutdown sequence cannot make one.
  mainWindow.webContents.on('input-event', (_event, input) => {
    if (isUserPresenceInput(input.type)) markUserPresent()
  })

  // The attention pipeline in the core suppresses alerts for the session the user is looking
  // at; it learns about focus only through these events, so report every transition.
  mainWindow.on('focus', () => host?.notify(WINDOW_FOCUS_CHANGED, [{ focused: true }]))
  mainWindow.on('blur', () => host?.notify(WINDOW_FOCUS_CHANGED, [{ focused: false }]))

  // A renderer reload subscribes afresh; replay the current core status so a window that
  // loads after a failure still lands in the recovery state instead of hanging.
  mainWindow.webContents.on('did-finish-load', () => {
    sendToRenderer(Channel.systemCoreStatus, coreStatus)
    host?.notify(WINDOW_FOCUS_CHANGED, [{ focused: mainWindow?.isFocused() ?? false }])
  })

  // The renderer shows content that originates outside the app (Notion, Slack, LLM output); a
  // clicked link must never navigate the app window itself, where the preload bridge would hand
  // the remote page the whole IPC surface. External links go through system.openExternal only.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== new URL(mainWindow!.webContents.getURL()).origin) {
      event.preventDefault()
    }
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

/** Fork the core utility process and hand it one end of a fresh message channel. */
function spawnCore(init: CoreInitMessage): {
  port: RpcPort
  kill(): void
  onExit(cb: (code: number | null) => void): void
} {
  const child = utilityProcess.fork(join(__dirname, 'core.js'), [], {
    serviceName: 'intersect-core',
    stdio: 'inherit',
    env: { ...process.env } as Record<string, string>
  })
  const { port1, port2 } = new MessageChannelMain()
  child.postMessage(init, [port1])
  return {
    port: port2 as unknown as RpcPort,
    kill: () => {
      child.kill()
    },
    onExit: (cb) => {
      child.on('exit', (code) => cb(code ?? null))
    }
  }
}

function wireCore(userDataDir: string, logger: Logger): void {
  const lifecycle = logger.child('lifecycle')
  host = createCoreHost({
    spawnCore,
    init: { kind: 'init', userDataDir, execPath: process.execPath, packaged: app.isPackaged },
    logger: lifecycle,
    onStatus: (status) => {
      coreStatus = status
      sendToRenderer(Channel.systemCoreStatus, status)
      // A dead core cannot retract its badge; clear it here so no stale count survives the
      // crash. A recovered core repopulates it through the canonical push when warranted.
      if (shouldZeroDockBadge(status)) setDockBadge(0)
      if (status.state === 'ready') log?.info('core ready')
      if (status.state === 'restarting') {
        log?.error('core crashed, restarting', {
          data: { attempt: status.attempt, message: status.message }
        })
      }
      if (status.state === 'failed') {
        log?.error('core failed', { data: { message: status.message } })
      }
    }
  })
  host.start()

  const pickFolder = async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a workspace folder'
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  }

  const pickVttFile = async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'VTT', extensions: ['vtt'] }],
      title: 'Choose a 1:1 recording (VTT)'
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  }

  const system = createSystemHandlers({
    openExternal: (url) => shell.openExternal(url),
    revealInFolder: (path) => shell.showItemInFolder(path),
    restartApp: () => {
      app.relaunch()
      app.exit(0)
    },
    retryCore: () => host?.retry(),
    quitApp: () => app.quit(),
    userDataDir,
    openPath: (path) => shell.openPath(path),
    // The core owns the settings, so the organisation the allowlist has to admit is asked for over
    // the bridge at the moment a link is opened.
    adoOrgUrl: async () => {
      const settings = (await host!.request(Channel.settingsGet, [])) as AppSettings
      return effectiveAdoOrgUrl(settings.ado, settings.adoFallback)
    }
  })

  registerCoreBridge({
    ipcMain,
    host,
    logger: lifecycle,
    electronOnly: {
      [Channel.workspacesPickFolder]: pickFolder,
      [Channel.oneOnOnePickVtt]: pickVttFile,
      [Channel.systemOpenExternal]: system.openExternal,
      [Channel.systemRevealPath]: system.revealPath,
      [Channel.systemRestartApp]: system.restartApp,
      [Channel.systemRetryCore]: system.retryCore,
      [Channel.systemQuitApp]: system.quitApp,
      [Channel.systemRevealUserData]: system.revealUserData
    },
    sendToRenderer: (channel, payload) => sendToRenderer(channel, payload),
    showNotification: showCoreNotification,
    // The dock badge is the at-a-glance count of sessions awaiting interaction, sourced
    // solely from the core's canonical attention count.
    setDockBadge
  })
}

app.whenReady().then(() => {
  const userDataDir = process.env.INTERSECT_USER_DATA_DIR || app.getPath('userData')
  const sink = createMainSink(userDataDir)
  const level = resolveLogLevel(process.env, app.isPackaged)
  log = createMainLogger({ userDataDir, env: process.env, packaged: app.isPackaged, sink })
  // Electron's own uncaught-exception listener stands down as soon as a second one exists, so the
  // error box it would have shown is raised here instead. A main process left in an undefined
  // state with nothing on screen is a failure the user has no way to report.
  installMainGlobalHandlers(log, (err) => {
    dialog.showErrorBox(
      'A JavaScript error occurred in the main process',
      err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : safeText(err)
    )
  })
  pruneLogsOnStartup(userDataDir, log)
  registerRendererLogReceiver({ ipcMain, sink, level, logger: log })
  log.info('app ready', { data: { userDataDir, packaged: app.isPackaged } })
  wireCore(userDataDir, log)
  createWindow()

  // The native menu owns every app-wide shortcut: macOS resolves accelerators before the key
  // reaches web contents, so they work even while a terminal holds keyboard focus. Items carry
  // no behaviour - each one forwards its command id to the renderer's command registry.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate((id) => sendToRenderer(Channel.shortcutInvoked, id), {
        devTools: !app.isPackaged
      })
    )
  )

  // Dock activation: focus the live window, or create exactly one new one that reattaches to
  // the still-running core sessions. `mainWindow` is assigned synchronously in createWindow,
  // so a burst of activations cannot create a second window.
  app.on('activate', () => {
    markUserPresent()
    const hasLiveWindow = mainWindow !== null && !mainWindow.isDestroyed()
    const action = activateAction({ hasLiveWindow, quitting })
    if (action === 'focus') mainWindow!.focus()
    if (action === 'create') createWindow()
  })

  // The one signal that says a quit will have nobody in front of it. On macOS this is
  // NSWorkspaceWillPowerOffNotification, which the system posts when the user asks to log out,
  // restart or shut down, and loginwindow only sends its quit request afterwards - so the claim is
  // always raised before before-quit reads it. Registering the listener is also what instantiates
  // powerMonitor, which is what installs the native handler, so it earns its place twice.
  //
  // The same broadcast reaches apps whose quit request never arrives, because any one app refusing
  // aborts the sequence. So the claim it raises is a standing one that user presence withdraws:
  // this listener states what the system just asked for, and the presence hooks state the moment
  // that account stopped being true.
  //
  // The default is deliberately left in place. Preventing it tells the system the app stopped the
  // shutdown, which turns the quit request that follows into a no-op and leaves the app to drive
  // its own exit; the shutdown is exactly what should proceed here.
  powerMonitor.on('shutdown', () => {
    unattendedShutdown.arm()
    log?.info('system shutdown signalled, the quit will not wait for a suspend answer')
  })
})

// Coordinated shutdown with a suspend-confirm guard. Cmd+Q / the Quit menu / system:quitApp / the
// system's own quit request at logout all funnel through before-quit. When live Claude sessions
// exist and a person is there we confirm first: the core's shutdown marks them `suspended` before
// it tears anything down, and the next launch resumes them in fresh processes - so this is an
// intentional suspend, and it says nothing about shell/dev-server process trees having been frozen.
// We preventDefault synchronously (keeping the ordering valid), then query the canonical live list
// and, if any, show a modal. Cancel changes nothing and leaves `quitting` false so a later quit
// re-prompts. Ordinary window close never reaches here.
app.on('before-quit', (event) => {
  if (quitting || !host) return
  event.preventDefault()
  void confirmAndQuit()
})

/**
 * Query the core for live Claude sessions, confirm the suspend with the user when any are running
 * and somebody is there to answer, and proceed to the coordinated teardown only when the decision is
 * to quit. Both the live-session query and the modal are async, which before-quit already made safe
 * by vetoing the default quit; a modal that blocked the main loop would also stall the shutdown it
 * is supposed to guard.
 *
 * An answer is waited for with no deadline, because elapsed time cannot tell a user who is thinking
 * from a machine that is logging out, and guessing wrong here discards a Cancel on the one dialog
 * that guards live work. The escape is the system's own power-off signal, which says outright that
 * this quit belongs to a shutdown; that quit takes the suspend teardown directly. The signal holds
 * only until somebody proves they are here, so an abandoned power-off hands the next quit its
 * dialog back.
 */
async function confirmAndQuit(): Promise<void> {
  let live: LiveClaudeSession[] = []
  try {
    live = (await host!.request(Channel.sessionsListLive, [])) as LiveClaudeSession[]
  } catch {
    // Core unreachable: nothing useful to preserve when we cannot see its state - proceed to quit.
    live = []
  }

  const unattended = unattendedShutdown.isUnattended()
  if (shouldConfirmQuit({ liveCount: live.length, unattended })) {
    const lines = live.map((s) => `  - ${s.title} (${s.workspace})`).join('\n')
    const options = {
      type: 'question' as const,
      buttons: ['Suspend & Quit', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Quit Intersect',
      message: `${live.length} Claude session${live.length === 1 ? ' is' : 's are'} still running.`,
      detail: `${lines}\n\nThey will be suspended and can resume on next launch.`
    }
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
    let response: number | null = null
    try {
      const answer = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options)
      response = answer.response
    } catch {
      // A prompt that cannot be shown must not quit behind the user's back: leave every session
      // and process alive, exactly as Cancel would.
      return
    }
    if (quitDecision(live.length, response) === 'stay') return
  } else if (live.length > 0) {
    log?.info('quitting without the suspend confirmation', {
      data: { liveSessions: live.length }
    })
  }

  quitting = true
  void host!.shutdown().finally(() => app.exit(0))
}

// Dock-only lifecycle on macOS: closing the last window leaves Electron, the core, and its
// PTYs running - a Dock click reattaches to the same live sessions. Elsewhere (and during a
// coordinated quit) the app exits with its windows.
app.on('window-all-closed', () => {
  if (shouldQuitOnWindowAllClosed({ platform: process.platform, quitting })) app.quit()
})
