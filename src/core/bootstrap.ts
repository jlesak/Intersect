import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AdoSettings, OtoRun, Preset } from '@common/domain'
import { debounce } from '@common/debounce'
import {
  NATIVE_DOCK_BADGE_PUSH,
  NATIVE_NOTIFICATION_PUSH,
  WINDOW_FOCUS_CHANGED,
  type NativeDockBadgeRequest,
  type NativeNotificationRequest,
  type WindowFocusChangedEvent,
  type WireRoutes
} from '@common/coreBridge'
import { Channel, parseSessionId, type SessionStatus } from '@common/ipc'
import { openDatabase } from './db/connection'
import { defaultRepoDeps } from './db/deps'
import { createAppStateRepo } from './db/appStateRepo'
import { createSettingsRepo } from './db/settingsRepo'
import { createTabRepo } from './db/tabRepo'
import { createWorkspaceRepo } from './db/workspaceRepo'
import { createDraftCommentRepo } from './db/draftCommentRepo'
import { createJiraCacheRepo } from './db/jiraCacheRepo'
import { tx } from './db/tx'
import { createPrCacheRepo } from './db/prCacheRepo'
import { createPrReviewWatermarkRepo } from './db/prReviewWatermarkRepo'
import { createReviewSessionRepo } from './db/reviewSessionRepo'
import { createSessionManager } from './pty/sessionManager'
import type { SpawnFn } from './pty/sessionManager'
import { createTerminalSnapshots } from './pty/terminalSnapshots'
import { createTerminalStream } from './pty/terminalStream'
import { buildSpawn } from './pty/shell'
import { createAttentionDetector } from './pty/attentionDetector'
import { writeNotifSettings } from './pty/notifSettings'
import { startHookListener, resolvePortRange, type HookListenerHandle } from './hooks/hookListener'
import {
  LISTENER_SIDECAR_FILENAME,
  readOrCreateToken,
  writeListenerSidecar
} from './hooks/listenerSidecar'
import { createSessionLifecycleService } from './hooks/sessionLifecycleService'
import { createHookEventRepo, HOOK_EVENT_RETENTION_MS } from './db/hookEventRepo'
import {
  USAGE_SNAPSHOT_FILENAME,
  USAGE_STATUSLINE_SCRIPT_FILENAME,
  resolveUserStatuslineCommand,
  usageStatuslineCommand,
  writeUsageStatuslineScript
} from './usage/usageStatusline'
import { createUsageService } from './usage/usageService'
import { createUsageHandlers, usageWireRoutes } from './api/usage.ipc'
import { createSessionNotifier } from './sessionNotifier'
import { createNotifyGate } from './notifyGate'
import { createWorkspaceHandlers, workspacesWireRoutes } from './api/workspaces.ipc'
import { createTabHandlers, tabsWireRoutes } from './api/tabs.ipc'
import {
  createTerminalHandlers,
  terminalWireRoutes,
  type TerminalHandlers
} from './api/terminal.ipc'
import { createPrInboxHandlers, prInboxWireRoutes } from './api/prInbox.ipc'
import { createSessionHandlers, sessionsWireRoutes } from './api/sessions.ipc'
import { createTimeTrackingHandlers, timeTrackingWireRoutes } from './api/timeTracking.ipc'
import { createAgentRuntimeHandlers, agentRuntimeWireRoutes } from './api/agentRuntime.ipc'
import { createTodoHandlers, todoWireRoutes } from './api/todo.ipc'
import { createProjectHandlers, projectsWireRoutes } from './api/projects.ipc'
import { createWorkItemsHandlers, workItemsWireRoutes } from './api/workItems.ipc'
import { createMyWorkHandlers, myWorkWireRoutes } from './api/myWork.ipc'
import { createOneOnOneHandlers, oneOnOneWireRoutes } from './api/oneOnOne.ipc'
import { createSettingsHandlers, settingsWireRoutes } from './api/settings.ipc'
import { createAgentToolingHandlers, agentToolingWireRoutes } from './api/agentTooling.ipc'
import { createClaudeConfigReader } from './agentTooling/claudeConfigReader'
import { createConfigWriter } from './agentTooling/configWriter'
import { testAdoConnection } from './settings/adoTestConnection'
import { createSessionIndex } from './sessions/sessionIndex'
import { createManualTimeEntryRepo, createTimeOverrideRepo } from './db/timeTrackingRepo'
import { createTodoRepo } from './db/todoRepo'
import { createProjectOverrideRepo } from './db/projectOverrideRepo'
import { createProjectRepo } from './db/projectRepo'
import { createTerminalLayoutRepo } from './db/terminalLayoutRepo'
import { createWorkItemRefRepo } from './db/workItemRefRepo'
import { canonicalizePath, projectPathDeps } from './projects/paths'
import { createTimeTracking } from './timeTracking/timeTracking'
import { createAgentRuntimeRepo } from './db/agentRuntimeRepo'
import {
  createAgentRuntimeService,
  type AgentRuntimeService
} from './agentRuntime/agentRuntimeService'
import { createJiraE2eStub } from './myWork/jiraE2eStub'
import { createJiraFetcher, type JiraFetcher } from './myWork/jiraFetch'
import { createJiraClient, type JiraFetchResult } from './myWork/jiraClient'
import { adaptHiddenBoardResult } from './myWork/jiraHiddenAdapter'
import { createJiraLogin } from './myWork/jiraLogin'
import { readStorageStateSession } from './myWork/jiraSession'
import { createJiraSyncEngine, type JiraQuery } from './myWork/jiraSyncEngine'
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
import { mergeRoutes, createDispatch, assertRoutesCoverBridge } from './wire'

/**
 * Everything the core cannot decide for itself: filesystem roots and the Electron binary
 * come from main's init message, pushes go back over the port, and the PTY/shell seams are
 * injected so the runtime is constructible in tests without native modules.
 */
export interface CoreRuntimeDeps {
  userDataDir: string
  /** Electron main's binary; hook/statusline scripts run it with ELECTRON_RUN_AS_NODE=1. */
  execPath: string
  env: NodeJS.ProcessEnv
  emitPush: (channel: string, payload: unknown) => void
  spawn: SpawnFn
  ensureSpawnHelper: () => void
  applyLoginShellPath: () => Promise<void>
}

export interface CoreRuntime {
  /** Serve one forwarded renderer request or notification. */
  handleRequest(channel: string, args: unknown[]): Promise<unknown>
  /** Deterministic teardown: PTYs, background services, then the database - exactly once. */
  shutdown(): void
}

/**
 * What each session status announces when its notification fires and Claude did not supply
 * its own message (the `Stop` hook never carries one; prompts usually do).
 */
const STATUS_BODY: Record<SessionStatus, string> = {
  working: 'Started working',
  waiting: 'Needs your permission',
  done: 'Finished - waiting for your next prompt'
}

/** Best-effort resolution of the `claude` binary for hidden Claude sessions. */
function resolveClaudePath(env: NodeJS.ProcessEnv): string {
  const explicit = env.INTERSECT_CLAUDE_PATH
  if (explicit) return explicit
  const local = join(homedir(), '.local', 'bin', 'claude')
  return existsSync(local) ? local : 'claude'
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
function safeDefaultProject(env: NodeJS.ProcessEnv, saved: AdoSettings | null): string {
  try {
    return resolveAdoServerConfig(env, saved).env.AZURE_DEVOPS_DEFAULT_PROJECT || 'SPOT'
  } catch {
    return 'SPOT'
  }
}

/**
 * Construct every service the core owns and wire the slices into one dispatch table. This
 * is the single composition root: only this function opens the production database, and the
 * returned shutdown is the only thing that closes it.
 */
export function createCoreRuntime(deps: CoreRuntimeDeps): CoreRuntime {
  const { userDataDir, execPath, env, emitPush } = deps
  const isE2e = env.INTERSECT_E2E === '1'

  deps.ensureSpawnHelper()
  // Launched from Finder/Dock, the process inherits only the bare /usr/bin:/bin PATH, so the
  // ADO MCP server's `npx` launcher would fail with ENOENT. Resolve the login-shell PATH in
  // the background (a heavy dotfile must not delay readiness); the ADO client awaits this
  // before its first non-PTY spawn, and PTYs run their own login shell and never depend on it.
  void deps.applyLoginShellPath()

  const db: DatabaseSync = openDatabase(userDataDir)

  // The app-managed Claude Code settings that wire each claude session's lifecycle hooks to
  // the bundled hook helper (a sibling script in this output directory). If they cannot be
  // written, the feature degrades to nothing rather than blocking boot, and the empty path
  // keeps `--settings` off the claude command.
  let notifSettingsPath = ''
  let usageSnapshotPath = ''
  try {
    const hookHelperPath = join(__dirname, 'hookHelper.js')

    // Usage-statusline tee: wired independently of the hooks, so a failure here still
    // leaves attention notifications working - buildNotifSettings just omits `statusLine`.
    let statusLineCommand: string | undefined
    try {
      const statuslineScriptPath = join(userDataDir, USAGE_STATUSLINE_SCRIPT_FILENAME)
      writeUsageStatuslineScript(statuslineScriptPath, userDataDir, readUserStatuslineCommand())
      statusLineCommand = usageStatuslineCommand(execPath, statuslineScriptPath)
      usageSnapshotPath = join(userDataDir, USAGE_SNAPSHOT_FILENAME)
    } catch {
      statusLineCommand = undefined
      usageSnapshotPath = ''
    }

    const path = join(userDataDir, 'intersect-claude-notif.json')
    writeNotifSettings(path, execPath, hookHelperPath, userDataDir, statusLineCommand)
    notifSettingsPath = path
  } catch {
    notifSettingsPath = ''
    usageSnapshotPath = ''
  }

  const repoDeps = defaultRepoDeps
  const workspaces = createWorkspaceRepo(db, repoDeps)
  const tabs = createTabRepo(db, repoDeps)
  const appState = createAppStateRepo(db)
  const settings = createSettingsRepo(db)
  // Created up front (not with its slice below) because workspace creation resolves its project.
  const projects = createProjectRepo(db, { ...repoDeps, canonicalize: canonicalizePath })
  // Created up front because tab creation can write a primary work item in the same transaction.
  const workItemRefs = createWorkItemRefRepo(db, repoDeps)
  // Shared with the work-items slice, which resolves candidate projects through the overrides.
  const projectOverrides = createProjectOverrideRepo(db, repoDeps)

  // The main window's focus, as last reported over the port. Main owns the window; the core
  // only needs the flag to suppress alerts for a session the user is already looking at.
  let windowFocused = false

  // Attention pipeline: detect Claude's "waiting for you" markers in the PTY stream, then
  // raise a native notification (through main) and recolor the tab (unless the user is
  // already looking at that session). 'working' is inferred separately, from the user
  // submitting a prompt (see the write wrapper below). The user's notification settings gate
  // which statuses reach the screen and whether they make a sound; they are read per event
  // so a settings change applies immediately.
  const detector = createAttentionDetector()
  const notifier = createSessionNotifier({
    detect: (sessionId, chunk) => {
      const alert = detector.push(sessionId, chunk)
      if (alert) console.log(`[lifecycle] ${sessionId}: '${alert.kind}' alert (source: marker)`)
      return alert
    },
    isWindowFocused: () => windowFocused,
    broadcastStatus: (sessionId, status, risk) =>
      emitPush(Channel.terminalSessionStatus, { sessionId, status, ...(risk ? { risk } : {}) }),
    notify: createNotifyGate(
      () => settings.getNotifications(),
      (sessionId, status, sound, message, risk) => {
        // Resolve the tab and workspace here, where the repos live; main just displays it.
        const parsed = parseSessionId(sessionId)
        const tab = parsed ? tabs.getById(parsed.tabId) : undefined
        const ws = parsed ? workspaces.getById(parsed.workspaceId) : undefined
        const request: NativeNotificationRequest = {
          sessionId,
          title: tab?.title ?? 'Claude Code',
          subtitle: ws?.name,
          // A dangerous permission request must be recognizable from the banner alone.
          body: (risk === 'dangerous' ? '[dangerous] ' : '') + (message ?? STATUS_BODY[status]),
          silent: !sound
        }
        emitPush(NATIVE_NOTIFICATION_PUSH, request)
      }
    ),
    // The dock badge is the at-a-glance count of sessions awaiting interaction across every
    // workspace, including ones not currently visible; it clears once every alert is
    // acknowledged. Main sets the badge; this count is the single source of truth.
    onPendingChanged: (count) => {
      const request: NativeDockBadgeRequest = { count }
      emitPush(NATIVE_DOCK_BADGE_PUSH, request)
    }
  })

  // Which preset each live session is (only a claude session's input drives 'working').
  const presetsBySession = new Map<string, Preset>()

  // Agent runtime evidence recompute, wired once its dependencies (the session index) exist. The
  // PTY-exit handler below closes over this holder, so it must be declared before the session
  // manager; `.current` is filled in when the service is constructed further down.
  const agentRuntimeRef: { current?: AgentRuntimeService } = {}

  // Hook lifecycle: raw event persistence with real retention, plus the per-session state
  // machine fed by the authenticated listener below. Alerts flow through the one notifier so
  // hook and marker paths share dedupe, presence gating, and the dock badge.
  const hookEvents = createHookEventRepo(db, repoDeps)
  hookEvents.pruneOlderThan(Date.now() - HOOK_EVENT_RETENTION_MS)
  const hookRetentionTimer = setInterval(
    () => hookEvents.pruneOlderThan(Date.now() - HOOK_EVENT_RETENTION_MS),
    6 * 60 * 60 * 1000
  )

  const lifecycle = createSessionLifecycleService({
    appendRawEvent: (sessionId, eventName, payload) =>
      hookEvents.append(sessionId, eventName, payload),
    storeClaudeSessionId: (sessionId, claudeSessionId) => {
      const parsed = parseSessionId(sessionId)
      if (parsed) tabs.setResumeSessionId(parsed.tabId, claudeSessionId)
    },
    alert: (sessionId, status, message, risk) => notifier.onAlert(sessionId, status, message, risk),
    markWorking: (sessionId) => notifier.onInput(sessionId),
    log: (message) => console.log(message)
  })

  // The authenticated localhost listener the hook helper posts to. Its failure to start is
  // never a boot failure - the PTY marker fallback keeps attention working, listener-less.
  // The sidecar advertising the bound port is written only after a successful bind.
  let hookListenerHandle: HookListenerHandle | null = null
  let hookListenerStopped = false
  try {
    const hookToken = readOrCreateToken(userDataDir)
    void startHookListener({
      token: hookToken,
      portRange: resolvePortRange(env),
      onEvent: (event, body, instanceId) => lifecycle.onHookEvent(event, body, instanceId)
    })
      .then((handle) => {
        // Shutdown can win the race against the bind; close the late listener right away.
        if (hookListenerStopped) {
          void handle.stop()
          return
        }
        hookListenerHandle = handle
        writeListenerSidecar(join(userDataDir, LISTENER_SIDECAR_FILENAME), {
          port: handle.port,
          writtenAt: Date.now()
        })
      })
      .catch((err) => {
        console.warn('[lifecycle] hook listener failed to start; marker fallback active:', err)
      })
  } catch (err) {
    console.warn('[lifecycle] hook listener setup failed; marker fallback active:', err)
  }

  // Headless snapshot pipeline: every PTY chunk is numbered and parsed into a per-session
  // headless xterm before fanout, so a reloaded renderer reattaches to the live PTY with its
  // screen, colors, and recent scrollback intact - no respawn, no lost or doubled output.
  const snapshots = createTerminalSnapshots()
  const terminalStream = createTerminalStream({
    snapshots,
    // The complete fanout for one chunk: the renderer push, then the marker detector - but
    // only while the session has not proven its hook wiring; once hook events flow, hooks
    // are authoritative and markers stand down.
    emit: (event) => {
      emitPush(Channel.terminalData, event)
      if (!lifecycle.isHookHealthy(event.sessionId)) notifier.onChunk(event.sessionId, event.data)
    },
    log: (message) => console.log(message)
  })

  const sessions = createSessionManager({
    spawn: deps.spawn,
    // PTY exit is always authoritative for the lifecycle regardless of hook health.
    send: {
      data: (event) => terminalStream.onData(event.sessionId, event.data),
      exit: (event) => {
        terminalStream.dispose(event.sessionId)
        emitPush(Channel.terminalExit, event)
        lifecycle.onPtyExit(event.sessionId, event.exitCode)
        // The session ended: reconcile its agent runtime evidence from the now-complete pings.
        try {
          agentRuntimeRef.current?.recomputeSession(event.sessionId)
        } catch (err) {
          console.warn('[agentRuntime] recompute on exit failed:', err)
        }
        notifier.forget(event.sessionId)
        detector.forget(event.sessionId)
        presetsBySession.delete(event.sessionId)
      }
    },
    buildSpec: (preset, resumeSessionId, sessionId) =>
      buildSpawn(preset, {
        testMode: isE2e,
        notifSettingsPath,
        resumeSessionId,
        instanceId: sessionId
      })
  })

  const workspaceHandlers = createWorkspaceHandlers({
    db,
    workspaces,
    tabs,
    appState,
    sessions,
    // Electron-only: the native folder dialog is answered by main and never forwarded here.
    pickFolder: () => Promise.reject(new Error('workspaces.pickFolder is Electron-only')),
    projects,
    pathDeps: projectPathDeps
  })
  const tabHandlers = createTabHandlers({ db, workspaces, tabs, workItems: workItemRefs, sessions })

  // Wrap spawn/write to drive the 'working' status: record each session's preset, then flag
  // a claude session 'working' the moment the user submits a prompt (Enter, i.e. '\r').
  // Resize and kill also tap the snapshot stream so it tracks the PTY's real dimensions and
  // never outlives the session.
  const baseTerminalHandlers = createTerminalHandlers(sessions, (id) => terminalStream.attach(id))
  const terminalHandlers: TerminalHandlers = {
    ...baseTerminalHandlers,
    spawn: (id, preset, cwd, cols, rows, resumeSessionId) => {
      presetsBySession.set(id, preset)
      // Only claude sessions live in the hook lifecycle; the recorded spawn cwd is what the
      // nested-session guard compares every hook payload's cwd against.
      if (preset === 'claude') lifecycle.onSpawn(id, cwd)
      // Track the stream before the PTY exists so the very first chunk (the spawn notice)
      // already lands in the snapshot; a failed spawn rolls the tracking back.
      const created = terminalStream.onSpawn(id, cols, rows)
      try {
        return baseTerminalHandlers.spawn(id, preset, cwd, cols, rows, resumeSessionId)
      } catch (err) {
        if (created) terminalStream.dispose(id)
        throw err
      }
    },
    write: (id, data) => {
      if (presetsBySession.get(id) === 'claude' && data.includes('\r')) {
        notifier.onInput(id)
        lifecycle.onUserInput(id)
      }
      baseTerminalHandlers.write(id, data)
    },
    resize: (id, cols, rows) => {
      terminalStream.onResize(id, cols, rows)
      baseTerminalHandlers.resize(id, cols, rows)
    },
    kill: (id) => {
      // PTY exit also disposes; doing it here too keeps the snapshot from outliving an exit
      // event that never arrives.
      terminalStream.dispose(id)
      baseTerminalHandlers.kill(id)
    }
  }

  // --- PR Review Inbox slice ---
  const prCache = createPrCacheRepo(db, repoDeps)
  const drafts = createDraftCommentRepo(db, repoDeps)
  const prReviewWatermarks = createPrReviewWatermarkRepo(db, repoDeps)
  const reviewSessions = createReviewSessionRepo(db, repoDeps)

  const adoClient = createAdoClient(() => resolveAdoServerConfig(env, settings.getSavedAdo()))
  const debouncedAdoTeardown = debounce(() => void adoClient.close(), 500)
  // E2E runs swap the ADO service for a canned one, so sync (and through it the My Work PR
  // radar) runs the real cache/watermark path without a live server.
  const adoStub = isE2e ? createAdoE2eStub(env) : null
  // One resolver shared by sync and the vote fallback so the connectionData identity lookup
  // runs at most once. An explicit INTERSECT_ADO_IDENTITY still overrides it.
  const identity = createIdentityResolver({
    resolveCredentials: () => resolveVoteCredentials(settings.getSavedAdo())
  })
  const resolveIdentity = identity.resolve
  const ado =
    adoStub ??
    createAdoService({
      client: adoClient,
      resolveIdentity,
      projectId: () => safeDefaultProject(env, settings.getSavedAdo()),
      priorThreadCount: (repositoryId, prId) =>
        prCache.get(repositoryId, prId)?.activeThreadCount ?? 0,
      resolveVoteCredentials: () => resolveVoteCredentials(settings.getSavedAdo())
    })

  const worktrees = createWorktreeManager(userDataDir)
  const workspaceFolders = (): string[] => workspaces.list().map((w) => w.folderPath)
  // E2E runs stub the diff engine too (no real clone on disk); production reads local git.
  const localDiff = isE2e
    ? createLocalDiffE2eStub(env)
    : createLocalDiffService({
        resolveRepoDir: (repoName, folders) => worktrees.resolveRepoDir(repoName, folders)
      })

  const review = createReviewManager({
    reviewSessions,
    drafts,
    prCache,
    worktrees,
    workspaceFolders,
    spawn: deps.spawn,
    sendData: (data) => emitPush(Channel.prInboxReviewData, data),
    sendExit: (exitCode) => emitPush(Channel.prInboxReviewExit, exitCode),
    onDraft: (draft) => emitPush(Channel.prInboxDraftAdded, draft),
    reviewPrompt: () => settings.getReview().prompt,
    draftServerPath: join(__dirname, 'draftServer.js')
  })
  const prInboxHandlers = createPrInboxHandlers({
    prCache,
    drafts,
    watermarks: prReviewWatermarks,
    ado,
    localDiff,
    workspaceFolders,
    review,
    atomically: (fn) => tx(db, fn),
    resolveIdentity
  })
  void review.pruneOnBoot().catch(() => {})

  // --- Session Search slice: read-only index over ~/.claude/projects (lazy, in memory) ---
  // The one index instance is shared with the Time Tracking slice so both read the same scan.
  const sessionIndex = createSessionIndex()

  const timeTrackingHandlers = createTimeTrackingHandlers({
    service: createTimeTracking({
      sessions: sessionIndex,
      manual: createManualTimeEntryRepo(db, repoDeps),
      overrides: createTimeOverrideRepo(db, repoDeps)
    })
  })

  // --- Agent runtime evidence slice: measured agent runtime derived from hook pings (primary)
  // and historical JSONL transcripts (coarse fallback), kept strictly separate from human
  // worklogs and never uploaded. Reuses the shared session index and the same project/ref
  // attribution the rest of the app uses. Recompute is idempotent, so the boot pass (after the
  // hook retention prune above) safely rebuilds the whole evidence set from current inputs.
  const agentRuntime = createAgentRuntimeService({
    hookEvents,
    workItemRefs,
    workspaces,
    tabs,
    projects,
    sessions: sessionIndex,
    pathDeps: projectPathDeps,
    repo: createAgentRuntimeRepo(db),
    now: () => Date.now()
  })
  agentRuntimeRef.current = agentRuntime
  void agentRuntime.recomputeAll().catch((err) => {
    console.warn('[agentRuntime] boot recompute failed:', err)
  })
  const agentRuntimeHandlers = createAgentRuntimeHandlers({ service: agentRuntime })

  const projectHandlers = createProjectHandlers({
    projects,
    pathDeps: projectPathDeps,
    workspaces,
    overrides: projectOverrides,
    terminalLayouts: createTerminalLayoutRepo(db, repoDeps)
  })

  // --- TODO list slice; the repo is shared with the 1:1 slice (read-only fulltext match) ---
  const todos = createTodoRepo(db, repoDeps)
  const todoHandlers = createTodoHandlers({ todos })

  // --- My Work slice: Jira boards synced directly and read-only with the SSO cookies (no PAT,
  // no Claude session). The engine owns the SQLite read model and the shared background refresh;
  // the login stays the existing interactive browser SSO flow. The legacy hidden-Claude fetcher
  // is a diagnostic-only fallback: it exists solely behind INTERSECT_JIRA_HIDDEN_FETCH=1 (one
  // release, then removed) and is never constructed on the default path.
  const jiraLogin = createJiraLogin()
  const jiraStub = isE2e ? createJiraE2eStub(env) : null
  const hiddenJiraFetcher: JiraFetcher | null =
    !isE2e && env.INTERSECT_JIRA_HIDDEN_FETCH === '1'
      ? createJiraFetcher({
          spawn: deps.spawn,
          claudePath: resolveClaudePath(env),
          reportServerPath: join(__dirname, 'jiraReportServer.js')
        })
      : null
  const jiraClient = createJiraClient({
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    readSession: () => readStorageStateSession()
  })
  const runJiraQuery = (sourceKey: string, query: JiraQuery): Promise<JiraFetchResult> => {
    // E2E runs script the fetch outcome at this seam, so the real engine + repo still run.
    if (jiraStub) return jiraStub.fetchBoard()
    if (hiddenJiraFetcher && sourceKey === 'global') {
      return hiddenJiraFetcher.fetchBoard().then(adaptHiddenBoardResult)
    }
    return query.kind === 'jql' ? jiraClient.searchByJql(query.jql) : jiraClient.fetchBoard(query.board)
  }
  const jiraCache = createJiraCacheRepo(db)
  const jiraEngine = createJiraSyncEngine({
    runQuery: runJiraQuery,
    repo: jiraCache,
    getProject: (id) => projects.getById(id),
    now: () => Date.now(),
    onChanged: (sourceKey) => emitPush(Channel.myWorkChanged, { sourceKey })
  })
  const myWorkHandlers = createMyWorkHandlers({
    engine: jiraEngine,
    login: jiraStub ? { login: () => jiraStub.login(), dispose: () => {} } : jiraLogin
  })

  // --- Work items slice: each session's one durable primary work item. Reads only the source
  // caches the other slices maintain; the only writers are the explicit user actions.
  const workItemsHandlers = createWorkItemsHandlers({
    refs: workItemRefs,
    workspaces,
    projects,
    overrides: projectOverrides,
    todos,
    prCache,
    jiraCache
  })

  // --- Claude usage slice: sidebar panel showing Claude Code's own rate-limit usage ---
  // usageSnapshotPath is '' when the statusline tee could not be wired at boot; the panel
  // then degrades to permanently-null usage rather than watching a bogus path.
  const usage = usageSnapshotPath ? createUsageService({ snapshotPath: usageSnapshotPath }) : null
  const usageHandlers = createUsageHandlers({ usage: usage ?? { get: () => null } })
  usage?.onChange((snapshot) => emitPush(Channel.usageChanged, snapshot))

  // --- Settings slice ---
  // Until the user saves ADO settings of their own, the form shows the effective config
  // resolved from ~/.claude.json / env, so what the app actually uses is what the user sees.
  const fallbackAdo = (): AdoSettings => {
    try {
      const resolved = resolveAdoServerConfig().env
      return {
        orgUrl: resolved.AZURE_DEVOPS_ORG_URL ?? '',
        project: resolved.AZURE_DEVOPS_DEFAULT_PROJECT ?? '',
        repository: '',
        pat: resolved.AZURE_DEVOPS_PAT ?? ''
      }
    } catch {
      return { orgUrl: '', project: '', repository: '', pat: '' }
    }
  }
  const settingsHandlers = createSettingsHandlers({
    settings,
    fallbackAdo,
    // E2E runs answer with a canned identity so the button never hits the network.
    testConnection: isE2e
      ? () => Promise.resolve({ ok: true as const, displayName: 'E2E User' })
      : (ado) => testAdoConnection(ado),
    // The MCP child keeps the credentials it was spawned with, so saving new ones must drop
    // it; the next PR-sync call reconnects with the fresh config instead of the stale
    // PAT/org. Debounced because the form persists per keystroke.
    adoSettingsChanged: () => {
      debouncedAdoTeardown()
      // A new org/PAT authenticates as a different person, so the memoized connectionData
      // identity must be dropped too; the next sync re-derives it.
      identity.invalidate()
      return Promise.resolve()
    }
  })

  // --- Agent Tooling slice: browse the effective Claude Code configuration, skills, and agents,
  // and guard every mutation (preview, atomic save, one-shot undo). Project scope resolves to the
  // project's canonical repository roots, the containment allowlist both the reader and the writer
  // gate every project-level file access against.
  const agentToolingHandlers = createAgentToolingHandlers({
    reader: createClaudeConfigReader(),
    writer: createConfigWriter(),
    resolveScope: (scope) => {
      if (scope.kind === 'global') return { kind: 'global' }
      const project = projects.getById(scope.projectId)
      if (!project) throw new Error(`Project not found: ${scope.projectId}`)
      return { kind: 'project', repoRoots: project.repoPaths }
    }
  })

  // --- 1:1 slice: the two workflows behind hidden Claude Code sessions + run history ---
  // Any run still 'running' in the DB belonged to a previous core process and can never finish.
  const otoRuns = createOtoRunRepo(db, repoDeps)
  otoRuns.reconcileOnBoot()
  const onOtoRunChanged = (run: OtoRun): void => emitPush(Channel.oneOnOneRunChanged, run)
  const oto = isE2e
    ? createOtoE2eStub({ runs: otoRuns, onRunChanged: onOtoRunChanged, env })
    : createOtoManager({
        runs: otoRuns,
        onRunChanged: onOtoRunChanged,
        spawn: deps.spawn,
        claudePath: resolveClaudePath(env),
        reportServerPath: join(__dirname, 'otoReportServer.js')
      })
  const oneOnOneHandlers = createOneOnOneHandlers({
    runs: otoRuns,
    manager: oto,
    todos,
    // Electron-only: the native file dialog is answered by main and never forwarded here.
    pickVttFile: () => Promise.reject(new Error('oneOnOne.pickVttFile is Electron-only'))
  })

  // Compose the slice contracts into the one dispatch table and hold it to the bridge's
  // channel classification - a drifting route list fails boot, not a user action.
  const focusRoute: WireRoutes = {
    [WINDOW_FOCUS_CHANGED]: (event: WindowFocusChangedEvent) => {
      windowFocused = event.focused
    }
  }
  const routes = mergeRoutes(
    workspacesWireRoutes(workspaceHandlers),
    projectsWireRoutes(projectHandlers),
    tabsWireRoutes(tabHandlers),
    workItemsWireRoutes(workItemsHandlers),
    terminalWireRoutes(terminalHandlers, (sessionId) => notifier.reportActive(sessionId)),
    prInboxWireRoutes(prInboxHandlers),
    sessionsWireRoutes(createSessionHandlers({ index: sessionIndex })),
    timeTrackingWireRoutes(timeTrackingHandlers),
    agentRuntimeWireRoutes(agentRuntimeHandlers),
    todoWireRoutes(todoHandlers),
    myWorkWireRoutes(myWorkHandlers),
    oneOnOneWireRoutes(oneOnOneHandlers),
    settingsWireRoutes(settingsHandlers),
    agentToolingWireRoutes(agentToolingHandlers),
    usageWireRoutes(usageHandlers)
  )
  assertRoutesCoverBridge(routes)
  const dispatch = createDispatch(mergeRoutes(routes, focusRoute))

  // Kill every PTY on shutdown so no shell process is orphaned. review.shutdown() is
  // synchronous and does NOT touch the DB, so closing the DB right after is safe (its async
  // PTY-exit handler is neutered by the disposed flag); a leftover worktree is reclaimed on
  // the next boot.
  let shutdownDone = false
  const shutdown = (): void => {
    if (shutdownDone) return
    shutdownDone = true
    // Stop accepting hook posts (and the retention timer) before the DB goes away.
    hookListenerStopped = true
    void hookListenerHandle?.stop().catch(() => {})
    clearInterval(hookRetentionTimer)
    sessions.killAll()
    terminalStream.disposeAll()
    review.shutdown()
    hiddenJiraFetcher?.dispose()
    jiraLogin.dispose()
    oto.dispose()
    usage?.dispose()
    debouncedAdoTeardown.cancel()
    void adoClient.close()
    db.close()
  }

  return { handleRequest: dispatch, shutdown }
}
