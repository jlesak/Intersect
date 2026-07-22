import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  Notification,
  shell,
  utilityProcess
} from 'electron'
import { Channel, type CoreStatus } from '@common/ipc'
import type { LiveClaudeSession } from '@common/domain'
import { WINDOW_FOCUS_CHANGED, type NativeNotificationRequest } from '@common/coreBridge'
import type { RpcPort } from '@common/portRpc'
import { createCoreHost, type CoreHost } from './coreHost'
import { registerCoreBridge } from './ipc/bridge'
import { createSystemHandlers } from './ipc/system.ipc'
import {
  activateAction,
  quitDecision,
  shouldQuitOnWindowAllClosed,
  shouldZeroDockBadge
} from './lifecycle'

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

/** The one place the Dock badge is written: the count of sessions awaiting interaction. */
function setDockBadge(count: number): void {
  app.dock?.setBadge(count > 0 ? String(count) : '')
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
  notification.on('failed', (_e, error) => console.error('[intersect] notification failed:', error))
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
function spawnCore(init: { kind: 'init'; userDataDir: string; execPath: string }): {
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

function wireCore(userDataDir: string): void {
  host = createCoreHost({
    spawnCore,
    init: { kind: 'init', userDataDir, execPath: process.execPath },
    onStatus: (status) => {
      coreStatus = status
      sendToRenderer(Channel.systemCoreStatus, status)
      // A dead core cannot retract its badge; clear it here so no stale count survives the
      // crash. A recovered core repopulates it through the canonical push when warranted.
      if (shouldZeroDockBadge(status)) setDockBadge(0)
      if (status.state === 'restarting') {
        console.error(`[intersect] core crashed (restart ${status.attempt}): ${status.message}`)
      }
      if (status.state === 'failed') {
        console.error(`[intersect] core failed: ${status.message}`)
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
    quitApp: () => app.quit()
  })

  registerCoreBridge({
    ipcMain,
    host,
    electronOnly: {
      [Channel.workspacesPickFolder]: pickFolder,
      [Channel.oneOnOnePickVtt]: pickVttFile,
      [Channel.systemOpenExternal]: system.openExternal,
      [Channel.systemRevealPath]: system.revealPath,
      [Channel.systemRestartApp]: system.restartApp,
      [Channel.systemRetryCore]: system.retryCore,
      [Channel.systemQuitApp]: system.quitApp
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
  wireCore(userDataDir)
  createWindow()

  // Dock activation: focus the live window, or create exactly one new one that reattaches to
  // the still-running core sessions. `mainWindow` is assigned synchronously in createWindow,
  // so a burst of activations cannot create a second window.
  app.on('activate', () => {
    const hasLiveWindow = mainWindow !== null && !mainWindow.isDestroyed()
    const action = activateAction({ hasLiveWindow, quitting })
    if (action === 'focus') mainWindow!.focus()
    if (action === 'create') createWindow()
  })
})

// Coordinated shutdown with a suspend-confirm guard. Cmd+Q / the Quit menu / system:quitApp all
// funnel through before-quit. When live Claude sessions exist we confirm first: the core's
// shutdown marks them `suspended` before it tears anything down, and the next launch resumes them
// in fresh processes - so this is an intentional suspend, not a claim that shell/dev-server
// process trees were frozen. We preventDefault synchronously (keeping the ordering valid), then
// query the canonical live list and, if any, show a synchronous modal. Cancel changes nothing and
// leaves `quitting` false so a later quit re-prompts. Ordinary window close never reaches here.
app.on('before-quit', (event) => {
  if (quitting || !host) return
  event.preventDefault()
  void confirmAndQuit()
})

/**
 * Query the core for live Claude sessions, confirm the suspend with the user when any are running,
 * and proceed to the coordinated teardown only when the decision is to quit. The modal is
 * synchronous on purpose; the async live-session query is safe because before-quit already vetoed
 * the default quit.
 */
async function confirmAndQuit(): Promise<void> {
  let live: LiveClaudeSession[] = []
  try {
    live = (await host!.request(Channel.sessionsListLive, [])) as LiveClaudeSession[]
  } catch {
    // Core unreachable: nothing useful to preserve when we cannot see its state - proceed to quit.
    live = []
  }

  let response: number | null = null
  if (live.length > 0) {
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
    response = win
      ? dialog.showMessageBoxSync(win, options)
      : dialog.showMessageBoxSync(options)
  }

  if (quitDecision(live.length, response) === 'stay') return
  quitting = true
  void host!.shutdown().finally(() => app.exit(0))
}

// Dock-only lifecycle on macOS: closing the last window leaves Electron, the core, and its
// PTYs running - a Dock click reattaches to the same live sessions. Elsewhere (and during a
// coordinated quit) the app exits with its windows.
app.on('window-all-closed', () => {
  if (shouldQuitOnWindowAllClosed({ platform: process.platform, quitting })) app.quit()
})
