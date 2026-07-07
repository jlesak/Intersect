import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import type { Preset } from '@common/domain'
import { Channel, parseSessionId, type SessionStatus } from '@common/ipc'
import { openDatabase } from './db/connection'
import { defaultRepoDeps } from './db/deps'
import { createAppStateRepo } from './db/appStateRepo'
import { createTabRepo, type TabRepo } from './db/tabRepo'
import { createWorkspaceRepo, type WorkspaceRepo } from './db/workspaceRepo'
import { createDraftCommentRepo } from './db/draftCommentRepo'
import { createMyWorkCacheRepo } from './db/myWorkCacheRepo'
import { tx } from './db/tx'
import { createPrCacheRepo } from './db/prCacheRepo'
import { createPrReviewWatermarkRepo } from './db/prReviewWatermarkRepo'
import { createReviewSessionRepo } from './db/reviewSessionRepo'
import { createSessionManager } from './pty/sessionManager'
import { ensureSpawnHelperExecutable, nodePtySpawn } from './pty/nodePtySpawn'
import { buildSpawn } from './pty/shell'
import { createAttentionDetector } from './pty/attentionDetector'
import { writeNotifSettings } from './pty/notifSettings'
import { createSessionNotifier } from './sessionNotifier'
import { createWorkspaceHandlers, registerWorkspaceHandlers } from './ipc/workspaces.ipc'
import { createTabHandlers, registerTabHandlers } from './ipc/tabs.ipc'
import {
  createSender,
  createTerminalHandlers,
  registerActiveSessionReporter,
  registerTerminalHandlers,
  type TerminalHandlers
} from './ipc/terminal.ipc'
import { createPrInboxHandlers, registerPrInboxHandlers } from './ipc/prInbox.ipc'
import { createSessionHandlers, registerSessionHandlers } from './ipc/sessions.ipc'
import { createTimeTrackingHandlers, registerTimeTrackingHandlers } from './ipc/timeTracking.ipc'
import { createTodoHandlers, registerTodoHandlers } from './ipc/todo.ipc'
import { createMyWorkHandlers, registerMyWorkHandlers } from './ipc/myWork.ipc'
import { createSystemHandlers, registerSystemHandlers } from './ipc/system.ipc'
import { createSessionIndex } from './sessions/sessionIndex'
import { createManualTimeEntryRepo, createTimeOverrideRepo } from './db/timeTrackingRepo'
import { createTodoRepo } from './db/todoRepo'
import { createTimeTracking } from './timeTracking/timeTracking'
import { createJiraE2eStub } from './myWork/jiraE2eStub'
import { createJiraFetcher } from './myWork/jiraFetch'
import { createJiraIndex } from './myWork/jiraIndex'
import { createJiraLogin } from './myWork/jiraLogin'
import { createAdoClient } from './prInbox/adoClient'
import { createAdoE2eStub } from './prInbox/adoE2eStub'
import { createAdoService } from './prInbox/adoService'
import { resolveAdoServerConfig, resolveMyIdentity } from './prInbox/adoConfig'
import { createReviewManager } from './prInbox/reviewManager'
import { createWorktreeManager } from './prInbox/worktreeManager'

// Deterministic userData dir -> ~/Library/Application Support/Intersect/ (or an E2E override).
app.setName('Intersect')

let mainWindow: BrowserWindow | null = null
let db: DatabaseSync | null = null

/** Best-effort resolution of the `claude` binary for the review session. */
function resolveClaudePath(): string {
  const explicit = process.env.INTERSECT_CLAUDE_PATH
  if (explicit) return explicit
  const local = join(homedir(), '.local', 'bin', 'claude')
  return existsSync(local) ? local : 'claude'
}

/** Fire-and-forget send to the renderer, guarded against a destroyed window. */
function sendToRenderer(channel: string, ...args: unknown[]): void {
  const wc = mainWindow?.webContents
  if (wc && !wc.isDestroyed()) wc.send(channel, ...args)
}

/**
 * Bring the app to the foreground from a background/minimised state (as when the user clicks a
 * session's notification) and hand the target session to the renderer to navigate to.
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
 * Raise the native macOS notification for a session that wants the user. Title/subtitle name the
 * tab and its workspace so the user knows which of many sessions is calling; clicking it focuses
 * the app and navigates there. No-ops silently where the OS cannot show notifications (e.g. an
 * unsigned dev build) or the session can no longer be resolved.
 */
function showAttentionNotification(
  sessionId: string,
  status: SessionStatus,
  tabs: TabRepo,
  workspaces: WorkspaceRepo
): void {
  if (!Notification.isSupported()) return
  const parsed = parseSessionId(sessionId)
  const tab = parsed ? tabs.getById(parsed.tabId) : undefined
  const ws = parsed ? workspaces.getById(parsed.workspaceId) : undefined

  const notification = new Notification({
    title: tab?.title ?? 'Claude Code',
    subtitle: ws?.name,
    body: status === 'waiting' ? 'Needs your permission' : 'Waiting for your input',
    silent: false
  })
  notification.on('click', () => focusAndNavigate(sessionId))
  // macOS (Electron 42+) only shows notifications for a code-signed app; an unsigned dev build
  // fires 'failed' instead of a banner. Log it so a missing banner is diagnosable, not silent.
  notification.on('failed', (_e, error) => console.error('[intersect] notification failed:', error))
  notification.show()
}

/** The configured ADO default project, or a sensible fallback if ADO isn't configured yet. */
function safeDefaultProject(): string {
  try {
    return resolveAdoServerConfig().env.AZURE_DEVOPS_DEFAULT_PROJECT || 'SPOT'
  } catch {
    return 'SPOT'
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#0e0f13',
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
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

function wireIpc(database: DatabaseSync, notifSettingsPath: string): void {
  const deps = defaultRepoDeps
  const workspaces = createWorkspaceRepo(database, deps)
  const tabs = createTabRepo(database, deps)
  const appState = createAppStateRepo(database)

  // Attention pipeline: detect Claude's "waiting for you" markers in the PTY stream, then raise a
  // native notification and recolor the tab (unless the user is already looking at that session).
  // 'working' is inferred separately, from the user submitting a prompt (see the write wrapper
  // below) - it never notifies, so it needs none of the suppress/dedup machinery.
  const detector = createAttentionDetector()
  const notifier = createSessionNotifier({
    detect: (sessionId, chunk) => detector.push(sessionId, chunk),
    isWindowFocused: () => mainWindow?.isFocused() ?? false,
    broadcastStatus: (sessionId, status) =>
      sendToRenderer(Channel.terminalSessionStatus, { sessionId, status }),
    notify: (sessionId, status) => showAttentionNotification(sessionId, status, tabs, workspaces)
  })

  // Which preset each live session is (only a claude session's input drives the 'working' status).
  const presetsBySession = new Map<string, Preset>()

  const baseSend = createSender(() => mainWindow?.webContents ?? null)
  const sessions = createSessionManager({
    spawn: nodePtySpawn,
    // Every PTY chunk also feeds the attention detector; exit clears its per-session state.
    send: {
      data: (event) => {
        baseSend.data(event)
        notifier.onChunk(event.sessionId, event.data)
      },
      exit: (event) => {
        baseSend.exit(event)
        notifier.forget(event.sessionId)
        detector.forget(event.sessionId)
        presetsBySession.delete(event.sessionId)
      }
    },
    buildSpec: (preset, resumeSessionId) =>
      buildSpawn(preset, {
        testMode: process.env.INTERSECT_E2E === '1',
        notifSettingsPath,
        resumeSessionId
      })
  })

  registerActiveSessionReporter(ipcMain, (sessionId) => notifier.reportActive(sessionId))

  const pickFolder = async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a workspace folder'
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  }

  registerWorkspaceHandlers(
    ipcMain,
    createWorkspaceHandlers({ db: database, workspaces, tabs, appState, sessions, pickFolder })
  )
  registerTabHandlers(ipcMain, createTabHandlers({ db: database, workspaces, tabs, sessions }))

  // Wrap spawn/write to drive the 'working' status: record each session's preset, then flag a
  // claude session 'working' the moment the user submits a prompt (an Enter keypress, i.e. '\r').
  const baseTerminalHandlers = createTerminalHandlers(sessions)
  const terminalHandlers: TerminalHandlers = {
    ...baseTerminalHandlers,
    spawn: (id, preset, cwd, cols, rows, resumeSessionId) => {
      presetsBySession.set(id, preset)
      return baseTerminalHandlers.spawn(id, preset, cwd, cols, rows, resumeSessionId)
    },
    write: (id, data) => {
      if (presetsBySession.get(id) === 'claude' && data.includes('\r')) notifier.onInput(id)
      baseTerminalHandlers.write(id, data)
    }
  }
  registerTerminalHandlers(ipcMain, terminalHandlers)

  // --- PR Review Inbox slice ---
  const prCache = createPrCacheRepo(database, deps)
  const drafts = createDraftCommentRepo(database, deps)
  const prReviewWatermarks = createPrReviewWatermarkRepo(database, deps)
  const reviewSessions = createReviewSessionRepo(database, deps)

  const adoClient = createAdoClient(() => resolveAdoServerConfig())
  const defaultProject = safeDefaultProject()
  // E2E runs swap the ADO service for a canned one, so sync (and through it the My Work PR radar)
  // runs the real cache/watermark path without a live server; everything else stays unchanged.
  const adoStub = process.env.INTERSECT_E2E === '1' ? createAdoE2eStub(process.env) : null
  const ado =
    adoStub ??
    createAdoService({
      client: adoClient,
      resolveIdentity: () => resolveMyIdentity(),
      projectId: defaultProject
    })

  const review = createReviewManager({
    reviewSessions,
    drafts,
    prCache,
    worktrees: createWorktreeManager(),
    workspaceFolders: () => workspaces.list().map((w) => w.folderPath),
    spawn: nodePtySpawn,
    sendData: (data) => sendToRenderer(Channel.prInboxReviewData, data),
    sendExit: (exitCode) => sendToRenderer(Channel.prInboxReviewExit, exitCode),
    onDraft: (draft) => sendToRenderer(Channel.prInboxDraftAdded, draft),
    claudePath: resolveClaudePath(),
    draftServerPath: join(__dirname, 'draftServer.js')
  })

  registerPrInboxHandlers(
    ipcMain,
    createPrInboxHandlers({
      prCache,
      drafts,
      watermarks: prReviewWatermarks,
      ado,
      review,
      atomically: (fn) => tx(database, fn)
    })
  )
  void review.pruneOnBoot().catch(() => {})

  // --- Session Search slice: read-only index over ~/.claude/projects (built lazily, in memory) ---
  // The one index instance is shared with the Time Tracking slice so both read the same scan.
  const sessionIndex = createSessionIndex()
  registerSessionHandlers(ipcMain, createSessionHandlers({ index: sessionIndex }))

  // --- Time Tracking slice: weekly worklog merged from Claude Code sessions + manual entries ---
  registerTimeTrackingHandlers(
    ipcMain,
    createTimeTrackingHandlers({
      service: createTimeTracking({
        sessions: sessionIndex,
        manual: createManualTimeEntryRepo(database, deps),
        overrides: createTimeOverrideRepo(database, deps)
      })
    })
  )

  // --- TODO list slice: a personal task list living entirely in local SQLite ---
  registerTodoHandlers(
    ipcMain,
    createTodoHandlers({ db: database, todos: createTodoRepo(database, deps) })
  )

  // --- My Work slice: Jira board fetched through a hidden Claude Code session (no PAT anywhere) ---
  // E2E runs get a stubbed backend: the section auto-fetches on first open (which is boot, since
  // it is the first section), and a real fetch would launch an actual claude session or browser.
  const jiraFetcher = createJiraFetcher({
    spawn: nodePtySpawn,
    claudePath: resolveClaudePath(),
    reportServerPath: join(__dirname, 'jiraReportServer.js')
  })
  const jiraLogin = createJiraLogin()
  const jiraStub = process.env.INTERSECT_E2E === '1' ? createJiraE2eStub(process.env) : null
  registerMyWorkHandlers(
    ipcMain,
    createMyWorkHandlers({
      index: createJiraIndex({
        fetch: jiraStub ? () => jiraStub.fetchBoard() : () => jiraFetcher.fetchBoard(),
        store: createMyWorkCacheRepo(database)
      }),
      login: jiraStub ? { login: () => jiraStub.login(), dispose: () => {} } : jiraLogin
    })
  )
  registerSystemHandlers(ipcMain, createSystemHandlers({ openExternal: (url) => shell.openExternal(url) }))

  // Kill every PTY when the app quits so no shell process is orphaned. review.shutdown() is
  // synchronous and does NOT touch the DB, so closing the DB immediately after is safe (its async
  // PTY-exit handler is neutered by the disposed flag); a leftover worktree is reclaimed on next boot.
  app.on('before-quit', () => {
    sessions.killAll()
    review.shutdown()
    jiraFetcher.dispose()
    jiraLogin.dispose()
    void adoClient.close()
    db?.close()
    db = null
  })
}

app.whenReady().then(() => {
  ensureSpawnHelperExecutable()
  const userDataDir = process.env.INTERSECT_USER_DATA_DIR || app.getPath('userData')
  db = openDatabase(userDataDir)
  // The app-managed Claude Code settings that make claude emit attention markers into the PTY. If
  // it cannot be written, the feature degrades to nothing rather than blocking app launch, and the
  // empty path keeps `--settings` off the claude command (never pointing it at a missing file).
  let notifSettingsPath = ''
  try {
    const path = join(userDataDir, 'intersect-claude-notif.json')
    writeNotifSettings(path)
    notifSettingsPath = path
  } catch {
    notifSettingsPath = ''
  }
  wireIpc(db, notifSettingsPath)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Single-window app: quitting on window close avoids a dock re-activate showing dead shells.
app.on('window-all-closed', () => {
  app.quit()
})
