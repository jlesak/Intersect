import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import type { AdoSettings, OtoRun, Preset } from '@common/domain'
import { debounce } from '@common/debounce'
import { Channel, parseSessionId, type SessionStatus } from '@common/ipc'
import { openDatabase } from './db/connection'
import { defaultRepoDeps } from './db/deps'
import { createAppStateRepo } from './db/appStateRepo'
import { createSettingsRepo } from './db/settingsRepo'
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
import { applyLoginShellPath } from './loginShellPath'
import { buildSpawn } from './pty/shell'
import { createAttentionDetector } from './pty/attentionDetector'
import { HOOK_SCRIPT_FILENAME, writeNotifHookScript, writeNotifSettings } from './pty/notifSettings'
import {
  USAGE_SNAPSHOT_FILENAME,
  USAGE_STATUSLINE_SCRIPT_FILENAME,
  resolveUserStatuslineCommand,
  usageStatuslineCommand,
  writeUsageStatuslineScript
} from './usage/usageStatusline'
import { createUsageService } from './usage/usageService'
import { createUsageHandlers, registerUsageHandlers } from './ipc/usage.ipc'
import { createSessionNotifier } from './sessionNotifier'
import { createNotifyGate } from './notifyGate'
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
import { createOneOnOneHandlers, registerOneOnOneHandlers } from './ipc/oneOnOne.ipc'
import { createSettingsHandlers, registerSettingsHandlers } from './ipc/settings.ipc'
import { createSystemHandlers, registerSystemHandlers } from './ipc/system.ipc'
import { testAdoConnection } from './settings/adoTestConnection'
import { createSessionIndex } from './sessions/sessionIndex'
import { createManualTimeEntryRepo, createTimeOverrideRepo } from './db/timeTrackingRepo'
import { createTodoRepo } from './db/todoRepo'
import { createTimeTracking } from './timeTracking/timeTracking'
import { createJiraE2eStub } from './myWork/jiraE2eStub'
import { createJiraFetcher } from './myWork/jiraFetch'
import { createJiraIndex } from './myWork/jiraIndex'
import { createJiraLogin } from './myWork/jiraLogin'
import { createOtoRunRepo } from './db/otoRunRepo'
import { createOtoE2eStub } from './oneOnOne/otoE2eStub'
import { createOtoManager } from './oneOnOne/otoManager'
import { createAdoClient } from './prInbox/adoClient'
import { createAdoE2eStub, createLocalDiffE2eStub } from './prInbox/adoE2eStub'
import { createAdoService } from './prInbox/adoService'
import { resolveAdoServerConfig, resolveVoteCredentials } from './prInbox/adoConfig'
import { createIdentityResolver } from './prInbox/adoIdentity'
import { createLocalDiffService } from './prInbox/localDiff'
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
 * What each session status announces when its notification fires and Claude did not supply its own
 * message (the `Stop` hook never carries one; `idle_prompt`/`permission_prompt` usually do).
 */
const STATUS_BODY: Record<SessionStatus, string> = {
  working: 'Started working',
  waiting: 'Needs your permission',
  done: 'Finished - waiting for your next prompt'
}

/**
 * Raise the native macOS notification for a session that wants the user. Title/subtitle name the
 * tab and its workspace so the user knows which of many sessions is calling; the body prefers
 * Claude's own notification text (e.g. "Claude needs your permission to use Bash") when the hook
 * supplied one, falling back to a generic status line otherwise. Clicking it focuses the app and
 * navigates there. No-ops silently where the OS cannot show notifications (e.g. an unsigned dev
 * build) or the session can no longer be resolved.
 */
function showAttentionNotification(
  sessionId: string,
  status: SessionStatus,
  tabs: TabRepo,
  workspaces: WorkspaceRepo,
  sound: boolean,
  message?: string
): void {
  if (!Notification.isSupported()) return
  const parsed = parseSessionId(sessionId)
  const tab = parsed ? tabs.getById(parsed.tabId) : undefined
  const ws = parsed ? workspaces.getById(parsed.workspaceId) : undefined

  const notification = new Notification({
    title: tab?.title ?? 'Claude Code',
    subtitle: ws?.name,
    body: message ?? STATUS_BODY[status],
    silent: !sound
  })
  notification.on('click', () => focusAndNavigate(sessionId))
  // macOS (Electron 42+) only shows notifications for a code-signed app; an unsigned dev build
  // fires 'failed' instead of a banner. Log it so a missing banner is diagnosable, not silent.
  notification.on('failed', (_e, error) => console.error('[intersect] notification failed:', error))
  notification.show()
}

/**
 * The user's own statusline command from `~/.claude/settings.json`, falling back to
 * `~/.claude/settings.local.json` per Claude Code's own precedence (local overrides
 * shared/global), or null if neither configures one. Read once at boot and baked into the
 * generated usage-statusline script, so the user's own statusline keeps rendering unchanged.
 */
function readUserStatuslineCommand(): string | null {
  const claudeDir = join(homedir(), '.claude')
  const readOrNull = (filename: string): string | null => {
    try {
      return readFileSync(join(claudeDir, filename), 'utf8')
    } catch {
      return null
    }
  }
  return resolveUserStatuslineCommand(readOrNull('settings.json'), readOrNull('settings.local.json'))
}

/** The configured ADO default project, or a sensible fallback if ADO isn't configured yet. */
function safeDefaultProject(saved: AdoSettings | null): string {
  try {
    return resolveAdoServerConfig(process.env, saved).env.AZURE_DEVOPS_DEFAULT_PROJECT || 'SPOT'
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

function wireIpc(database: DatabaseSync, notifSettingsPath: string, usageSnapshotPath: string): void {
  const deps = defaultRepoDeps
  const workspaces = createWorkspaceRepo(database, deps)
  const tabs = createTabRepo(database, deps)
  const appState = createAppStateRepo(database)
  const settings = createSettingsRepo(database)

  // Attention pipeline: detect Claude's "waiting for you" markers in the PTY stream, then raise a
  // native notification and recolor the tab (unless the user is already looking at that session).
  // 'working' is inferred separately, from the user submitting a prompt (see the write wrapper
  // below). The user's notification settings gate which statuses reach the screen and whether
  // they make a sound; they are read per event so a settings change applies immediately.
  const detector = createAttentionDetector()
  const notifier = createSessionNotifier({
    detect: (sessionId, chunk) => detector.push(sessionId, chunk),
    isWindowFocused: () => mainWindow?.isFocused() ?? false,
    broadcastStatus: (sessionId, status) =>
      sendToRenderer(Channel.terminalSessionStatus, { sessionId, status }),
    notify: createNotifyGate(
      () => settings.getNotifications(),
      (sessionId, status, sound, message) =>
        showAttentionNotification(sessionId, status, tabs, workspaces, sound, message)
    ),
    // The dock badge is the at-a-glance count of sessions awaiting interaction across every
    // workspace, including ones not currently visible; it clears once every alert is acknowledged.
    onPendingChanged: (count) => app.dock?.setBadge(count > 0 ? String(count) : '')
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

  const adoClient = createAdoClient(() => resolveAdoServerConfig(process.env, settings.getSavedAdo()))
  const debouncedAdoTeardown = debounce(() => void adoClient.close(), 500)
  // E2E runs swap the ADO service for a canned one, so sync (and through it the My Work PR radar)
  // runs the real cache/watermark path without a live server; everything else stays unchanged.
  const adoStub = process.env.INTERSECT_E2E === '1' ? createAdoE2eStub(process.env) : null
  // One resolver shared by sync and the vote fallback so the connectionData identity lookup runs at
  // most once. An explicit INTERSECT_ADO_IDENTITY still overrides it without a network call.
  const identity = createIdentityResolver({
    resolveCredentials: () => resolveVoteCredentials(settings.getSavedAdo())
  })
  const resolveIdentity = identity.resolve
  const ado =
    adoStub ??
    createAdoService({
      client: adoClient,
      resolveIdentity,
      projectId: () => safeDefaultProject(settings.getSavedAdo()),
      priorThreadCount: (repositoryId, prId) =>
        prCache.get(repositoryId, prId)?.activeThreadCount ?? 0,
      resolveVoteCredentials: () => resolveVoteCredentials(settings.getSavedAdo())
    })

  const worktrees = createWorktreeManager()
  const workspaceFolders = (): string[] => workspaces.list().map((w) => w.folderPath)
  // E2E runs stub the diff engine too (no real clone on disk); production reads from local git.
  const localDiff =
    process.env.INTERSECT_E2E === '1'
      ? createLocalDiffE2eStub(process.env)
      : createLocalDiffService({
          resolveRepoDir: (repoName, folders) => worktrees.resolveRepoDir(repoName, folders)
        })

  const review = createReviewManager({
    reviewSessions,
    drafts,
    prCache,
    worktrees,
    workspaceFolders,
    spawn: nodePtySpawn,
    sendData: (data) => sendToRenderer(Channel.prInboxReviewData, data),
    sendExit: (exitCode) => sendToRenderer(Channel.prInboxReviewExit, exitCode),
    onDraft: (draft) => sendToRenderer(Channel.prInboxDraftAdded, draft),
    reviewPrompt: () => settings.getReview().prompt,
    draftServerPath: join(__dirname, 'draftServer.js')
  })

  registerPrInboxHandlers(
    ipcMain,
    createPrInboxHandlers({
      prCache,
      drafts,
      watermarks: prReviewWatermarks,
      ado,
      localDiff,
      workspaceFolders,
      review,
      atomically: (fn) => tx(database, fn),
      resolveIdentity
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
  // The repo is shared with the 1:1 slice, which fulltext-matches task texts (read-only).
  const todos = createTodoRepo(database, deps)
  registerTodoHandlers(ipcMain, createTodoHandlers({ todos }))

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

  // --- Claude usage slice: sidebar panel showing Claude Code's own rate-limit usage ---
  // usageSnapshotPath is '' when the statusline tee could not be wired at boot (see
  // app.whenReady below); the panel then degrades to permanently-null usage rather than
  // watching a bogus path. sendToRenderer pushes every fresh snapshot live, mirroring how
  // session status is pushed.
  const usage = usageSnapshotPath ? createUsageService({ snapshotPath: usageSnapshotPath }) : null
  registerUsageHandlers(ipcMain, createUsageHandlers({ usage: usage ?? { get: () => null } }))
  usage?.onChange((snapshot) => sendToRenderer(Channel.usageChanged, snapshot))

  // --- Settings slice: notification/ADO/appearance preferences persisted in local SQLite ---
  // Until the user saves ADO settings of their own, the form shows the effective config resolved
  // from ~/.claude.json / env, so what the app actually uses is what the user sees.
  const fallbackAdo = (): AdoSettings => {
    try {
      const env = resolveAdoServerConfig().env
      return {
        orgUrl: env.AZURE_DEVOPS_ORG_URL ?? '',
        project: env.AZURE_DEVOPS_DEFAULT_PROJECT ?? '',
        repository: '',
        pat: env.AZURE_DEVOPS_PAT ?? ''
      }
    } catch {
      return { orgUrl: '', project: '', repository: '', pat: '' }
    }
  }
  registerSettingsHandlers(
    ipcMain,
    createSettingsHandlers({
      settings,
      fallbackAdo,
      // E2E runs answer with a canned identity so the button never makes a live network request.
      testConnection:
        process.env.INTERSECT_E2E === '1'
          ? () => Promise.resolve({ ok: true as const, displayName: 'E2E User' })
          : (ado) => testAdoConnection(ado),
      // The MCP child keeps the credentials it was spawned with, so saving new ones must drop it;
      // the next PR-sync call reconnects with the fresh config instead of the stale PAT/org. The
      // teardown is debounced: the form persists per keystroke, so an un-debounced close would drop
      // the live client (and any in-flight PR sync) on every character - this coalesces a burst into
      // a single teardown once the edit settles.
      adoSettingsChanged: () => {
        debouncedAdoTeardown()
        // A new org/PAT authenticates as a different person, so the memoized connectionData
        // identity must be dropped too; the next sync re-derives it from the fresh credentials.
        identity.invalidate()
        return Promise.resolve()
      }
    })
  )

  // --- 1:1 slice: the two workflows behind hidden Claude Code sessions, plus their run history ---
  // Any run still 'running' in the DB belonged to a previous app process and can never finish.
  const otoRuns = createOtoRunRepo(database, deps)
  otoRuns.reconcileOnBoot()
  const onOtoRunChanged = (run: OtoRun): void => sendToRenderer(Channel.oneOnOneRunChanged, run)
  const oto =
    process.env.INTERSECT_E2E === '1'
      ? createOtoE2eStub({ runs: otoRuns, onRunChanged: onOtoRunChanged, env: process.env })
      : createOtoManager({
          runs: otoRuns,
          onRunChanged: onOtoRunChanged,
          spawn: nodePtySpawn,
          claudePath: resolveClaudePath(),
          reportServerPath: join(__dirname, 'otoReportServer.js')
        })
  const pickVttFile = async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'VTT', extensions: ['vtt'] }],
      title: 'Choose a 1:1 recording (VTT)'
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  }
  registerOneOnOneHandlers(
    ipcMain,
    createOneOnOneHandlers({ runs: otoRuns, manager: oto, todos, pickVttFile })
  )

  // Kill every PTY when the app quits so no shell process is orphaned. review.shutdown() is
  // synchronous and does NOT touch the DB, so closing the DB immediately after is safe (its async
  // PTY-exit handler is neutered by the disposed flag); a leftover worktree is reclaimed on next boot.
  app.on('before-quit', () => {
    sessions.killAll()
    review.shutdown()
    jiraFetcher.dispose()
    jiraLogin.dispose()
    oto.dispose()
    usage?.dispose()
    debouncedAdoTeardown.cancel()
    void adoClient.close()
    db?.close()
    db = null
  })
}

app.whenReady().then(() => {
  ensureSpawnHelperExecutable()
  // Launched from Finder/Dock, the app inherits only the bare /usr/bin:/bin PATH, so the ADO MCP
  // server's `npx` launcher would fail with ENOENT. Resolve the login-shell PATH off the main
  // thread (a heavy dotfile must not delay window paint); the ADO client awaits this before its
  // first non-PTY spawn, and PTYs run their own login shell and never depend on it.
  void applyLoginShellPath()
  const userDataDir = process.env.INTERSECT_USER_DATA_DIR || app.getPath('userData')
  db = openDatabase(userDataDir)
  // The app-managed Claude Code settings that make claude emit attention markers into the PTY. If
  // it cannot be written, the feature degrades to nothing rather than blocking app launch, and the
  // empty path keeps `--settings` off the claude command (never pointing it at a missing file).
  let notifSettingsPath = ''
  let usageSnapshotPath = ''
  try {
    const hookScriptPath = join(userDataDir, HOOK_SCRIPT_FILENAME)
    writeNotifHookScript(hookScriptPath)

    // Usage-statusline tee: wired independently of the hook script, so a failure here still
    // leaves attention notifications working - buildNotifSettings just omits `statusLine`.
    let statusLineCommand: string | undefined
    try {
      const statuslineScriptPath = join(userDataDir, USAGE_STATUSLINE_SCRIPT_FILENAME)
      writeUsageStatuslineScript(statuslineScriptPath, userDataDir, readUserStatuslineCommand())
      statusLineCommand = usageStatuslineCommand(process.execPath, statuslineScriptPath)
      usageSnapshotPath = join(userDataDir, USAGE_SNAPSHOT_FILENAME)
    } catch {
      statusLineCommand = undefined
      usageSnapshotPath = ''
    }

    const path = join(userDataDir, 'intersect-claude-notif.json')
    writeNotifSettings(path, process.execPath, hookScriptPath, statusLineCommand)
    notifSettingsPath = path
  } catch {
    // Nothing gets `--settings`, so statusLine never reaches claude either - keep the usage
    // snapshot path empty too rather than watching a directory that will never be written to.
    notifSettingsPath = ''
    usageSnapshotPath = ''
  }
  wireIpc(db, notifSettingsPath, usageSnapshotPath)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Single-window app: quitting on window close avoids a dock re-activate showing dead shells.
app.on('window-all-closed', () => {
  app.quit()
})
