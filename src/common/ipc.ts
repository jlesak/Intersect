import type {
  AdoConnectionResult,
  AdoSettings,
  AgentCatalogItem,
  AgentRuntimeDay,
  AgentRuntimeEvidence,
  AgentToolingScope,
  AppSettings,
  BootState,
  ClaudeUsage,
  ConfigEditRequest,
  ConfigPreview,
  ConfigSaveRequest,
  ConfigSaveResult,
  ConfigSource,
  ConfigUndoResult,
  DraftComment,
  EffectiveConfig,
  RawTargetView,
  SkillCatalogItem,
  FileDiff,
  JiraBoardSnapshot,
  JiraLoginResult,
  Layout,
  LiveClaudeSession,
  NewManualDraft,
  NewManualTimeEntry,
  NewPrComment,
  NotificationSettings,
  OtoRun,
  OtoStartInput,
  Preset,
  PrChangeFile,
  Project,
  ProjectOverride,
  ProjectOverrideKind,
  ProjectPatch,
  RepoWorktrees,
  PrThread,
  PrVote,
  PullRequest,
  ReviewSettings,
  ReviewSession,
  SessionSettings,
  SessionSummary,
  SessionTranscript,
  Tab,
  TimeEntry,
  TimeEntrySource,
  TimeEntryUpdate,
  TodoLists,
  TodoTask,
  TodoTaskPatch,
  NewWorkItemRef,
  WorkItemCandidateGroup,
  WorkItemRef,
  WorkItemRefEvent,
  Workspace
} from './domain'
import type {
  LayoutShares,
  ResizableLayout,
  TerminalLayoutSharesMap
} from './terminalLayoutShares'

/**
 * The single source of truth for the renderer <-> main contract. `main` implements these
 * handlers, `preload` mirrors them onto `window.intersect`, and the renderer calls them
 * through the slice-local ipc modules. Because thrown errors only carry their `.message`
 * across the IPC boundary, handlers surface failures as message-only Errors.
 */
export interface IpcApi {
  workspaces: {
    getState(): Promise<BootState>
    create(folderPath: string, name?: string): Promise<Workspace>
    rename(id: string, name: string): Promise<Workspace>
    remove(id: string): Promise<void>
    setLayout(id: string, layout: Layout): Promise<Workspace>
    setActive(id: string): Promise<void>
    pickFolder(): Promise<string | null>
    /** Manually place the workspace in a project (null = the Other bucket); wins over inference. */
    assignProject(id: string, projectId: string | null): Promise<Workspace>
    /** Return the workspace to automatic assignment and re-resolve it from its folder path. */
    autoAssignProject(id: string): Promise<Workspace>
  }
  projects: {
    /** Every project (archived included), in manual order. */
    list(): Promise<Project[]>
    /** Create a project bound to one repository folder. */
    create(name: string, folderPath: string): Promise<Project>
    /** Edit name and external-tool bindings; an omitted patch field is left unchanged. */
    update(id: string, patch: ProjectPatch): Promise<Project>
    setArchived(id: string, archived: boolean): Promise<Project>
    /** Persist the complete project order atomically and return the canonical list. */
    reorder(orderedIds: string[]): Promise<Project[]>
    /** App-state delete: workspaces detach to the Other bucket; folders/remotes are untouched. */
    remove(id: string): Promise<void>
    addRepoPath(id: string, folderPath: string): Promise<Project>
    removeRepoPath(id: string, folderPath: string): Promise<Project>
    /** Which project a filesystem path belongs to; null means the virtual Other bucket. */
    resolvePath(path: string): Promise<string | null>
    /** Every persisted manual assignment override for external content (PRs, Jira issues). */
    listOverrides(): Promise<ProjectOverride[]>
    /** Pin one external item to a project (null = Other); persists and wins over inference. */
    setOverride(kind: ProjectOverrideKind, key: string, projectId: string | null): Promise<void>
    /** Drop the item's manual pin so it falls back to binding-based inference. */
    clearOverride(kind: ProjectOverrideKind, key: string): Promise<void>
    /** The git worktrees under each of the project's repository bindings. */
    listWorktrees(id: string): Promise<RepoWorktrees[]>
    /**
     * Every persisted terminal pane-share value for the project key (a project id, or the
     * literal 'other' for the virtual bucket of unassigned workspaces). Absent layouts mean
     * the caller should use equal shares.
     */
    getTerminalLayouts(projectKey: string): Promise<TerminalLayoutSharesMap>
    /** Persist one layout's pane shares for the project key; values are validated in the core. */
    setTerminalLayout(
      projectKey: string,
      layout: ResizableLayout,
      shares: LayoutShares
    ): Promise<void>
  }
  tabs: {
    listByWorkspace(workspaceId: string): Promise<Tab[]>
    /**
     * `resumeSessionId` makes a Claude tab launch `claude --resume <id>` (see Tab.resumeSessionId).
     * `primaryWorkItem` assigns the session's primary work item in the same transaction as the tab
     * itself (the card-launch path), also defaulting the tab title from the item's snapshot.
     */
    create(
      workspaceId: string,
      preset: Preset,
      resumeSessionId?: string | null,
      primaryWorkItem?: NewWorkItemRef | null
    ): Promise<Tab>
    rename(id: string, title: string): Promise<Tab>
    remove(id: string): Promise<void>
    reorder(workspaceId: string, orderedIds: string[]): Promise<Tab[]>
    assignToPane(id: string, slot: number | null): Promise<Tab>
    setActive(workspaceId: string, tabId: string): Promise<void>
  }
  workItems: {
    /** Every primary ref of the workspace's tabs, each with its freshly computed state. */
    listForWorkspace(workspaceId: string): Promise<WorkItemRef[]>
    /** Assign or replace the tab's primary work item; the audit history records which. */
    setPrimary(tabId: string, ref: NewWorkItemRef): Promise<WorkItemRef>
    /** Drop the tab's primary work item (audited); a tab without one is a silent no-op. */
    clearPrimary(tabId: string): Promise<void>
    /** The tab's full assign/change/clear history, oldest first. Survives tab deletion. */
    history(tabId: string): Promise<WorkItemRefEvent[]>
    /**
     * Searchable picker candidates across every source (cached Jira issues, open TODO tasks,
     * cached PRs), matched on key and title, grouped by source, each carrying a ready-to-assign
     * ref with its effective project resolved. `workspaceId` ranks the workspace's own project
     * first; null skips the ranking.
     */
    searchCandidates(query: string, workspaceId: string | null): Promise<WorkItemCandidateGroup[]>
  }
  terminal: {
    spawn(
      sessionId: string,
      preset: Preset,
      cwd: string,
      cols: number,
      rows: number,
      /** Claude session UUID to resume (`claude --resume <id>`); omit/null for a fresh session. */
      resumeSessionId?: string | null
    ): Promise<{ ok: boolean }>
    /**
     * Reattach to a PTY that survived a renderer reload: returns the serialized screen
     * snapshot plus the exactly-once boundary for the live stream that follows (see
     * TerminalAttachResult). `live: false` when no such PTY exists - the caller spawns instead.
     */
    attach(sessionId: string): Promise<TerminalAttachResult>
    write(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    /** Backpressure: ask main to pause/resume the child pty when the renderer buffer is over/under water. */
    pause(sessionId: string): void
    resume(sessionId: string): void
    kill(sessionId: string): void
    /**
     * Tell main which session the user is currently viewing (or null when no terminal is in
     * focus). Main uses it to suppress attention alerts for the session already on screen and to
     * clear a session's pending-alert state once the user acknowledges it by opening it.
     */
    reportActiveSession(sessionId: string | null): void
    /** Subscribe to PTY output for all sessions; returns an unsubscribe fn. */
    onData(cb: (msg: TerminalDataEvent) => void): () => void
    /** Subscribe to PTY exit for all sessions; returns an unsubscribe fn. */
    onExit(cb: (msg: TerminalExitEvent) => void): () => void
    /** A Claude Code session's status changed (working / waiting for you / done). */
    onSessionStatus(cb: (msg: TerminalSessionStatusEvent) => void): () => void
    /** The user clicked a session's native notification; navigate to it. */
    onNotificationClicked(cb: (msg: TerminalNotificationClickEvent) => void): () => void
  }
  prInbox: {
    /** Fan-out fetch every active PR I author/review, replace the cache, return the fresh list. */
    sync(): Promise<PullRequest[]>
    /** The cached PRs from the last sync (no network). */
    list(): Promise<PullRequest[]>
    getChanges(repositoryId: string, prId: number): Promise<PrChangeFile[]>
    getFileDiff(repositoryId: string, prId: number, filePath: string): Promise<FileDiff>
    getThreads(repositoryId: string, prId: number): Promise<PrThread[]>
    /** Publish my own comment immediately (ADO behaviour); returns the PR's fresh threads. */
    addComment(input: NewPrComment): Promise<PrThread[]>
    /** Reply into an existing thread under my identity; returns the PR's fresh threads. */
    replyToThread(repositoryId: string, prId: number, threadId: number, body: string): Promise<PrThread[]>
    /** Resolve ('fixed') or reactivate ('active') a thread; returns the PR's fresh threads. */
    setThreadStatus(
      repositoryId: string,
      prId: number,
      threadId: number,
      status: 'active' | 'fixed'
    ): Promise<PrThread[]>
    listDrafts(repositoryId: string, prId: number): Promise<DraftComment[]>
    addManualDraft(input: NewManualDraft): Promise<DraftComment>
    editDraft(id: string, body: string): Promise<DraftComment>
    discardDraft(id: string): Promise<void>
    /** Publishes the draft to Azure DevOps, under my identity, only after my explicit approval. */
    publishDraft(id: string): Promise<DraftComment>
    /**
     * Cast my reviewer vote on the PR, immediately and under my identity, then return the updated
     * cached PR (my vote recorded and the review watermark moved to its current source commit).
     */
    castVote(repositoryId: string, prId: number, vote: PrVote): Promise<PullRequest>
    startReview(repositoryId: string, prId: number): Promise<ReviewSession>
    endReview(): Promise<void>
    // Review terminal I/O for the single live session.
    reviewInput(data: string): void
    reviewResize(cols: number, rows: number): void
    onReviewData(cb: (data: string) => void): () => void
    onReviewExit(cb: (exitCode: number) => void): () => void
    /** Fired when a draft is recorded (by the review session or manually) so the UI refreshes live. */
    onDraftAdded(cb: (draft: DraftComment) => void): () => void
  }
  sessions: {
    /** Past Claude Code sessions, newest activity first. Builds the in-memory index on first call. */
    list(): Promise<SessionSummary[]>
    /** Re-scan `~/.claude/projects` from disk and return the fresh list. */
    refresh(): Promise<SessionSummary[]>
    /** The full, on-demand transcript for one session id. */
    getTranscript(id: string): Promise<SessionTranscript>
    /**
     * Every managed Claude session currently live, with its tab/workspace display names. Read by the
     * quit modal so it can list what would be suspended; empty when nothing is running.
     */
    listLive(): Promise<LiveClaudeSession[]>
    /** Clear a tab's suspend marker once the renderer has respawned it (audited as a resume). */
    clearSuspended(tabId: string): Promise<void>
  }
  timeTracking: {
    /**
     * The merged worklog entries (auto from Claude Code sessions + manual) for the Monday-Friday
     * week starting at the given Monday day key (`yyyy-mm-dd`, local calendar).
     */
    getWeek(weekStart: string): Promise<TimeEntry[]>
    /** Re-scan the Claude Code session index from disk, then return the fresh week. */
    refreshWeek(weekStart: string): Promise<TimeEntry[]>
    addManual(input: NewManualTimeEntry): Promise<TimeEntry>
    /** Edit time/issue key on any card; an auto edit persists as an override keyed by session id. */
    updateEntry(source: TimeEntrySource, id: string, update: TimeEntryUpdate): Promise<TimeEntry>
    /** Delete a card. An auto card is tombstoned so it never resurrects on a later re-scan. */
    deleteEntry(source: TimeEntrySource, id: string): Promise<void>
  }
  agentRuntime: {
    /**
     * Per-day agent-runtime rollup for the Monday-Friday week (minutes SUMMED across sessions, so
     * three parallel one-hour agents read as 180 minutes). Supporting context only - never a
     * worklog and never uploaded.
     */
    getWeek(weekStart: string): Promise<AgentRuntimeDay[]>
    /** The same per-day rollup restricted to one project. */
    getForProject(projectId: string, weekStart: string): Promise<AgentRuntimeDay[]>
    /** The raw evidence rows for one session (hook `workspaceId:tabId` or `jsonl:<uuid>`). */
    getForSession(sessionId: string): Promise<AgentRuntimeEvidence[]>
    /** Recompute all evidence from hook pings plus the JSONL fallback; idempotent and converging. */
    refresh(): Promise<void>
  }
  todo: {
    /** Both TODO lists: open tasks in manual order, done most recently first. */
    list(): Promise<TodoLists>
    add(text: string, dueDay: string | null): Promise<TodoTask>
    /** Edit any subset of a task's fields in place (inline editing). */
    update(id: string, patch: TodoTaskPatch): Promise<TodoTask>
    /** Checking stamps the completion time; unchecking appends the task to the end of the open list. */
    setDone(id: string, done: boolean): Promise<TodoTask>
    remove(id: string): Promise<void>
    /** Persist the complete open-task order atomically and return the canonical list. */
    reorder(orderedIds: string[]): Promise<TodoTask[]>
  }
  myWork: {
    /**
     * The global "assigned to me" board from the read-model cache, immediately. A stale cache
     * (older than five minutes) also starts one shared background refresh; its completion is
     * announced via onChanged so the caller can refetch.
     */
    list(): Promise<JiraBoardSnapshot>
    /** Force one direct Jira fetch of the global board (joining a refresh already in flight). */
    refresh(): Promise<JiraBoardSnapshot>
    /** Interactive SSO login: opens a headed browser window and resolves once it completes. */
    login(): Promise<JiraLoginResult>
    /** One project's own board (its JQL filter or board URL), with the same cache semantics as list. */
    projectBoard(projectId: string): Promise<JiraBoardSnapshot>
    /** Force one direct Jira fetch of the project's board. */
    refreshProject(projectId: string): Promise<JiraBoardSnapshot>
    /** Fired when a source's background refresh completes, so the shown board can refetch. */
    onChanged(cb: (event: MyWorkChangedEvent) => void): () => void
  }
  oneOnOne: {
    /** The full run history, newest first. */
    list(): Promise<OtoRun[]>
    /** Validate the input, start the hidden session, and return the new `running` run. */
    start(input: OtoStartInput): Promise<OtoRun>
    /** Native file picker restricted to .vtt files; null when the user cancels. */
    pickVttFile(): Promise<string | null>
    /** Fired whenever a run finishes (done or failed) so the history refreshes live. */
    onRunChanged(cb: (run: OtoRun) => void): () => void
  }
  settings: {
    /** Every user setting at once; unsaved ADO fields fall back to the env/`~/.claude.json` config. */
    get(): Promise<AppSettings>
    setNotifications(notifications: NotificationSettings): Promise<AppSettings>
    setAdo(ado: AdoSettings): Promise<AppSettings>
    setTerminalFontSize(px: number): Promise<AppSettings>
    setReview(review: ReviewSettings): Promise<AppSettings>
    setSession(session: SessionSettings): Promise<AppSettings>
    /**
     * Hit the real Azure DevOps API with exactly the given (possibly unsaved) form values and
     * report who the PAT authenticates as, or a readable failure. Never touches saved settings.
     */
    testAdoConnection(ado: AdoSettings): Promise<AdoConnectionResult>
  }
  agentTooling: {
    /**
     * The fully resolved effective Claude Code configuration for the scope, every leaf carrying
     * its provenance. Malformed layers degrade to per-file diagnostics; the rest still resolves.
     */
    getEffectiveConfig(scope: AgentToolingScope): Promise<EffectiveConfig>
    /** The searchable skills catalog for the scope (user + plugin, plus project-level in a Project). */
    listSkills(scope: AgentToolingScope): Promise<SkillCatalogItem[]>
    /** The searchable agents catalog for the scope (user + plugin, plus project-level in a Project). */
    listAgents(scope: AgentToolingScope): Promise<AgentCatalogItem[]>
    /**
     * The current text + revision of one writable target file, for the guarded raw JSON editor.
     * Never creates a missing file; a containment breach rejects.
     */
    readRaw(scope: AgentToolingScope, source: ConfigSource): Promise<RawTargetView>
    /**
     * Preview a structured or raw mutation of one config file: the current and proposed bytes,
     * the revision guard, and any validation errors. Mutates nothing (a missing target still
     * previews as a create).
     */
    previewSave(req: ConfigEditRequest): Promise<ConfigPreview>
    /**
     * Commit a previewed mutation. Rejects when the file changed since the preview (revision
     * mismatch), backs up the prior bytes, writes atomically, and arms a one-shot undo.
     */
    commitSave(req: ConfigSaveRequest): Promise<ConfigSaveResult>
    /** Undo the last committed save of `targetPath`, restoring the exact prior bytes (guarded). */
    undoSave(targetPath: string): Promise<ConfigUndoResult>
  }
  system: {
    /** Open an allowlisted https URL in the system default browser. Rejects anything else. */
    openExternal(url: string): Promise<void>
    /**
     * Reveal a discovered config/skill/agent source file in the OS file manager. Electron-only and
     * guarded: the path must be an existing regular file contained under a `.claude` root. Fails
     * closed on anything else.
     */
    revealPath(path: string): Promise<void>
    /**
     * The absolute filesystem path of a dropped File. Implemented entirely in preload (Electron's
     * webUtils is preload-only) - it never crosses IPC and main does not implement it.
     */
    getPathForFile(file: File): string
    /** Relaunch the app - the recovery action when the core process failed. */
    restartApp(): Promise<void>
    /** Ask main to start a fresh core process after automatic recovery gave up. */
    retryCore(): Promise<void>
    /** Quit the app through the coordinated shutdown path (same as Cmd+Q). */
    quitApp(): Promise<void>
    /**
     * The core service process's lifecycle as seen by main. Fired on every change and once
     * with the current status when the renderer loads, so a reload lands in the right state.
     */
    onCoreStatus(cb: (status: CoreStatus) => void): () => void
  }
  usage: {
    /** The last captured Claude Code rate-limit snapshot, or null if none has arrived yet. */
    get(): Promise<ClaudeUsage | null>
    /** Fired whenever a fresh statusline snapshot is captured. */
    onUsageChanged(cb: (usage: ClaudeUsage | null) => void): () => void
  }
}

export interface TerminalDataEvent {
  sessionId: string
  data: string
  /**
   * Per-session monotonic chunk counter assigned by the core. An attach response's `lastSeq`
   * splits the stream exactly: chunks with seq <= lastSeq are already contained in the attach
   * snapshot, so a reattaching renderer drops them instead of rendering them twice. Absent only
   * on chunks racing session teardown, when nothing tracks the counter anymore.
   */
  seq?: number
}

/**
 * Answer to terminal.attach. `live: false` means the core has no such PTY and the renderer
 * should spawn one. A live answer carries the replayable ANSI snapshot (colors, screen state,
 * capped scrollback), the PTY's current dimensions, and the sequence number of the last chunk
 * the snapshot contains - the exactly-once boundary for the pushes that follow.
 */
export type TerminalAttachResult =
  | { live: false }
  | { live: true; data: string; cols: number; rows: number; lastSeq: number }
export interface TerminalExitEvent {
  sessionId: string
  exitCode: number
}

/**
 * The visible state of a Claude Code session, driving both the tab's color and (for the two
 * action-needed states) a native notification. `working` = it is actively processing a turn;
 * `waiting` = blocked on a tool-permission decision; `done` = it finished a turn and is waiting
 * for the next prompt. Absence of a status (no entry) means neutral - a shell tab, or a Claude tab
 * that has not sent its first prompt yet.
 */
export const SESSION_STATUSES = ['working', 'waiting', 'done'] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

/**
 * How risky the tool call behind a `waiting` permission request looks. Metadata attached to
 * the attention event, never a status of its own: 'ordinary' covers positively recognized
 * read-only tools, 'dangerous' covers destructive shell patterns, and everything the
 * classifier cannot vouch for stays 'unknown'.
 */
export const PERMISSION_RISKS = ['ordinary', 'dangerous', 'unknown'] as const
export type PermissionRisk = (typeof PERMISSION_RISKS)[number]

/** Broadcast whenever a session's status changes. */
export interface TerminalSessionStatusEvent {
  sessionId: string
  status: SessionStatus
  /** Present on 'waiting' when the permission request was risk-classified. */
  risk?: PermissionRisk
}

/** Payload delivered to the renderer when a session's notification is clicked. */
export interface TerminalNotificationClickEvent {
  sessionId: string
}

/** Broadcast when a Jira source's background refresh completes (successfully or not). */
export interface MyWorkChangedEvent {
  sourceKey: string
}

/**
 * Lifecycle of the headless core process that owns the database, PTYs, and background
 * services. `starting` covers fork + bootstrap; `restarting` means the core died and an
 * automatic respawn is pending or underway (`attempt` numbers the restart within the rolling
 * crash-loop window); `failed` means the restart gate is exhausted or bootstrap gave up -
 * recoverable only by an explicit user retry or quit. `message` carries the user-readable
 * reason for either recovery state.
 */
export interface CoreStatus {
  state: 'starting' | 'ready' | 'restarting' | 'failed'
  message?: string
  attempt?: number
}

/**
 * Channel names. Request/response channels use ipcMain.handle / ipcRenderer.invoke.
 * Terminal I/O channels are fire-and-forget (`send`) plus a single multiplexed data
 * channel the renderer demuxes by sessionId.
 */
export const Channel = {
  // workspaces (request/response)
  workspacesGetState: 'workspaces:getState',
  workspacesCreate: 'workspaces:create',
  workspacesRename: 'workspaces:rename',
  workspacesRemove: 'workspaces:remove',
  workspacesSetLayout: 'workspaces:setLayout',
  workspacesSetActive: 'workspaces:setActive',
  workspacesPickFolder: 'workspaces:pickFolder',
  workspacesAssignProject: 'workspaces:assignProject',
  workspacesAutoAssignProject: 'workspaces:autoAssignProject',
  // projects (request/response)
  projectsList: 'projects:list',
  projectsCreate: 'projects:create',
  projectsUpdate: 'projects:update',
  projectsSetArchived: 'projects:setArchived',
  projectsReorder: 'projects:reorder',
  projectsRemove: 'projects:remove',
  projectsAddRepoPath: 'projects:addRepoPath',
  projectsRemoveRepoPath: 'projects:removeRepoPath',
  projectsResolvePath: 'projects:resolvePath',
  projectsListOverrides: 'projects:listOverrides',
  projectsSetOverride: 'projects:setOverride',
  projectsClearOverride: 'projects:clearOverride',
  projectsListWorktrees: 'projects:listWorktrees',
  projectsGetTerminalLayouts: 'projects:getTerminalLayouts',
  projectsSetTerminalLayout: 'projects:setTerminalLayout',
  // tabs (request/response)
  tabsListByWorkspace: 'tabs:listByWorkspace',
  tabsCreate: 'tabs:create',
  tabsRename: 'tabs:rename',
  tabsRemove: 'tabs:remove',
  tabsReorder: 'tabs:reorder',
  tabsAssignToPane: 'tabs:assignToPane',
  tabsSetActive: 'tabs:setActive',
  // workItems (request/response)
  workItemsListForWorkspace: 'workItems:listForWorkspace',
  workItemsSetPrimary: 'workItems:setPrimary',
  workItemsClearPrimary: 'workItems:clearPrimary',
  workItemsHistory: 'workItems:history',
  workItemsSearchCandidates: 'workItems:searchCandidates',
  // terminal (request/response for spawn and attach; fire-and-forget for the rest)
  terminalSpawn: 'terminal:spawn',
  terminalAttach: 'terminal:attach',
  terminalInput: 'terminal:input',
  terminalResize: 'terminal:resize',
  terminalPause: 'terminal:pause',
  terminalResume: 'terminal:resume',
  terminalKill: 'terminal:kill',
  terminalReportActive: 'terminal:reportActive',
  // terminal (main -> renderer broadcasts)
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  terminalSessionStatus: 'terminal:sessionStatus',
  terminalNotificationClicked: 'terminal:notificationClicked',
  // prInbox (request/response)
  prInboxSync: 'prInbox:sync',
  prInboxList: 'prInbox:list',
  prInboxGetChanges: 'prInbox:getChanges',
  prInboxGetFileDiff: 'prInbox:getFileDiff',
  prInboxGetThreads: 'prInbox:getThreads',
  prInboxAddComment: 'prInbox:addComment',
  prInboxReplyToThread: 'prInbox:replyToThread',
  prInboxSetThreadStatus: 'prInbox:setThreadStatus',
  prInboxListDrafts: 'prInbox:listDrafts',
  prInboxAddManualDraft: 'prInbox:addManualDraft',
  prInboxEditDraft: 'prInbox:editDraft',
  prInboxDiscardDraft: 'prInbox:discardDraft',
  prInboxPublishDraft: 'prInbox:publishDraft',
  prInboxCastVote: 'prInbox:castVote',
  prInboxStartReview: 'prInbox:startReview',
  prInboxEndReview: 'prInbox:endReview',
  // prInbox review terminal (fire-and-forget input/resize; broadcasts for data/exit/draft)
  prInboxReviewInput: 'prInbox:reviewInput',
  prInboxReviewResize: 'prInbox:reviewResize',
  prInboxReviewData: 'prInbox:reviewData',
  prInboxReviewExit: 'prInbox:reviewExit',
  prInboxDraftAdded: 'prInbox:draftAdded',
  // sessions (request/response)
  sessionsList: 'sessions:list',
  sessionsRefresh: 'sessions:refresh',
  sessionsGetTranscript: 'sessions:getTranscript',
  sessionsListLive: 'sessions:listLive',
  sessionsClearSuspended: 'sessions:clearSuspended',
  // timeTracking (request/response)
  timeTrackingGetWeek: 'timeTracking:getWeek',
  timeTrackingRefreshWeek: 'timeTracking:refreshWeek',
  timeTrackingAddManual: 'timeTracking:addManual',
  timeTrackingUpdateEntry: 'timeTracking:updateEntry',
  timeTrackingDeleteEntry: 'timeTracking:deleteEntry',
  // agentRuntime (request/response)
  agentRuntimeGetWeek: 'agentRuntime:getWeek',
  agentRuntimeGetForProject: 'agentRuntime:getForProject',
  agentRuntimeGetForSession: 'agentRuntime:getForSession',
  agentRuntimeRefresh: 'agentRuntime:refresh',
  // todo (request/response)
  todoList: 'todo:list',
  todoAdd: 'todo:add',
  todoUpdate: 'todo:update',
  todoSetDone: 'todo:setDone',
  todoRemove: 'todo:remove',
  todoReorder: 'todo:reorder',
  // myWork (request/response, plus a main -> renderer broadcast for refresh completion)
  myWorkList: 'myWork:list',
  myWorkRefresh: 'myWork:refresh',
  myWorkLogin: 'myWork:login',
  myWorkProjectBoard: 'myWork:projectBoard',
  myWorkRefreshProject: 'myWork:refreshProject',
  myWorkChanged: 'myWork:changed',
  // oneOnOne (request/response, plus a main -> renderer broadcast)
  oneOnOneList: 'oneOnOne:list',
  oneOnOneStart: 'oneOnOne:start',
  oneOnOnePickVtt: 'oneOnOne:pickVtt',
  oneOnOneRunChanged: 'oneOnOne:runChanged',
  // settings (request/response)
  settingsGet: 'settings:get',
  settingsSetNotifications: 'settings:setNotifications',
  settingsSetAdo: 'settings:setAdo',
  settingsSetTerminalFontSize: 'settings:setTerminalFontSize',
  settingsSetReview: 'settings:setReview',
  settingsSetSession: 'settings:setSession',
  settingsTestAdoConnection: 'settings:testAdoConnection',
  // agentTooling (request/response)
  agentToolingGetEffectiveConfig: 'agentTooling:getEffectiveConfig',
  agentToolingListSkills: 'agentTooling:listSkills',
  agentToolingListAgents: 'agentTooling:listAgents',
  agentToolingReadRaw: 'agentTooling:readRaw',
  agentToolingPreviewSave: 'agentTooling:previewSave',
  agentToolingCommitSave: 'agentTooling:commitSave',
  agentToolingUndoSave: 'agentTooling:undoSave',
  // system (request/response, plus a main -> renderer broadcast for core lifecycle)
  systemOpenExternal: 'system:openExternal',
  systemRevealPath: 'system:revealPath',
  systemRestartApp: 'system:restartApp',
  systemRetryCore: 'system:retryCore',
  systemQuitApp: 'system:quitApp',
  systemCoreStatus: 'system:coreStatus',
  // usage (request/response, plus a main -> renderer broadcast)
  usageGet: 'usage:get',
  usageChanged: 'usage:changed'
} as const

export type ChannelName = (typeof Channel)[keyof typeof Channel]

/** Build the stable `${workspaceId}:${tabId}` session id used across the PTY layer. */
export function makeSessionId(workspaceId: string, tabId: string): string {
  return `${workspaceId}:${tabId}`
}

/**
 * Inverse of makeSessionId. Ids are colon-free (nanoids), so splitting on the first colon is exact.
 * Returns null for a malformed id so callers can safely ignore late/garbled events.
 */
export function parseSessionId(sessionId: string): { workspaceId: string; tabId: string } | null {
  const i = sessionId.indexOf(':')
  if (i <= 0 || i >= sessionId.length - 1) return null
  return { workspaceId: sessionId.slice(0, i), tabId: sessionId.slice(i + 1) }
}
