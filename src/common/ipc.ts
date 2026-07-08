import type {
  AdoConnectionResult,
  AdoSettings,
  AppSettings,
  BootState,
  DraftComment,
  FileDiff,
  JiraBoardResult,
  JiraLoginResult,
  Layout,
  NewManualDraft,
  NewManualTimeEntry,
  NotificationSettings,
  OtoRun,
  OtoStartInput,
  Preset,
  PrChangeFile,
  PrThread,
  PrVote,
  PullRequest,
  ReviewSession,
  SessionSummary,
  SessionTranscript,
  Tab,
  TimeEntry,
  TimeEntrySource,
  TimeEntryUpdate,
  TodoLists,
  TodoTask,
  Workspace
} from './domain'

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
  }
  tabs: {
    listByWorkspace(workspaceId: string): Promise<Tab[]>
    /** `resumeSessionId` makes a Claude tab launch `claude --resume <id>` (see Tab.resumeSessionId). */
    create(workspaceId: string, preset: Preset, resumeSessionId?: string | null): Promise<Tab>
    rename(id: string, title: string): Promise<Tab>
    remove(id: string): Promise<void>
    reorder(workspaceId: string, orderedIds: string[]): Promise<Tab[]>
    assignToPane(id: string, slot: number | null): Promise<Tab>
    setActive(workspaceId: string, tabId: string): Promise<void>
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
    write(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    /** Backpressure: ask main to XOFF/XON the child when the renderer buffer is over/under water. */
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
  todo: {
    /** Both TODO lists: open tasks in manual order, done tasks most recently completed first. */
    list(): Promise<TodoLists>
    add(text: string, dueDay: string | null): Promise<TodoTask>
    /** Checking stamps the completion time; unchecking appends the task to the end of the open list. */
    setDone(id: string, done: boolean): Promise<TodoTask>
    remove(id: string): Promise<void>
    /** Persist a manual reordering of the open list; returns it in the new order. */
    reorder(orderedIds: string[]): Promise<TodoTask[]>
  }
  myWork: {
    /** The cached My Work Jira board; the first call fetches it via a hidden Claude Code session. */
    list(): Promise<JiraBoardResult>
    /** Force a fresh board fetch (a new hidden session), ignoring the cache. */
    refresh(): Promise<JiraBoardResult>
    /** Interactive SSO login: opens a headed browser window and resolves once it completes. */
    login(): Promise<JiraLoginResult>
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
    /**
     * Hit the real Azure DevOps API with exactly the given (possibly unsaved) form values and
     * report who the PAT authenticates as, or a readable failure. Never touches saved settings.
     */
    testAdoConnection(ado: AdoSettings): Promise<AdoConnectionResult>
  }
  system: {
    /** Open an allowlisted https URL in the system default browser. Rejects anything else. */
    openExternal(url: string): Promise<void>
    /**
     * The absolute filesystem path of a dropped File. Implemented entirely in preload (Electron's
     * webUtils is preload-only) - it never crosses IPC and main does not implement it.
     */
    getPathForFile(file: File): string
  }
}

export interface TerminalDataEvent {
  sessionId: string
  data: string
}
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

/** Broadcast whenever a session's status changes. */
export interface TerminalSessionStatusEvent {
  sessionId: string
  status: SessionStatus
}

/** Payload delivered to the renderer when a session's notification is clicked. */
export interface TerminalNotificationClickEvent {
  sessionId: string
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
  // tabs (request/response)
  tabsListByWorkspace: 'tabs:listByWorkspace',
  tabsCreate: 'tabs:create',
  tabsRename: 'tabs:rename',
  tabsRemove: 'tabs:remove',
  tabsReorder: 'tabs:reorder',
  tabsAssignToPane: 'tabs:assignToPane',
  tabsSetActive: 'tabs:setActive',
  // terminal (request/response for spawn; fire-and-forget for the rest)
  terminalSpawn: 'terminal:spawn',
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
  // timeTracking (request/response)
  timeTrackingGetWeek: 'timeTracking:getWeek',
  timeTrackingRefreshWeek: 'timeTracking:refreshWeek',
  timeTrackingAddManual: 'timeTracking:addManual',
  timeTrackingUpdateEntry: 'timeTracking:updateEntry',
  timeTrackingDeleteEntry: 'timeTracking:deleteEntry',
  // todo (request/response)
  todoList: 'todo:list',
  todoAdd: 'todo:add',
  todoSetDone: 'todo:setDone',
  todoRemove: 'todo:remove',
  todoReorder: 'todo:reorder',
  // myWork (request/response)
  myWorkList: 'myWork:list',
  myWorkRefresh: 'myWork:refresh',
  myWorkLogin: 'myWork:login',
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
  settingsTestAdoConnection: 'settings:testAdoConnection',
  // system (request/response)
  systemOpenExternal: 'system:openExternal'
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
