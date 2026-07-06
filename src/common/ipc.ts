import type {
  BootState,
  DraftComment,
  FileDiff,
  Layout,
  NewManualDraft,
  Preset,
  PrChangeFile,
  PrThread,
  PullRequest,
  ReviewSession,
  Tab,
  Workspace
} from './domain'

/**
 * The single source of truth for the renderer <-> main contract. `main` implements these
 * handlers, `preload` mirrors them onto `window.jarvis`, and the renderer calls them
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
    create(workspaceId: string, preset: Preset): Promise<Tab>
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
      rows: number
    ): Promise<{ ok: boolean }>
    write(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    /** Backpressure: ask main to XOFF/XON the child when the renderer buffer is over/under water. */
    pause(sessionId: string): void
    resume(sessionId: string): void
    kill(sessionId: string): void
    /** Subscribe to PTY output for all sessions; returns an unsubscribe fn. */
    onData(cb: (msg: TerminalDataEvent) => void): () => void
    /** Subscribe to PTY exit for all sessions; returns an unsubscribe fn. */
    onExit(cb: (msg: TerminalExitEvent) => void): () => void
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
    /** The only path that writes to Azure DevOps; publishes under my identity after my approval. */
    publishDraft(id: string): Promise<DraftComment>
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
  // terminal (main -> renderer broadcasts)
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
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
  prInboxStartReview: 'prInbox:startReview',
  prInboxEndReview: 'prInbox:endReview',
  // prInbox review terminal (fire-and-forget input/resize; broadcasts for data/exit/draft)
  prInboxReviewInput: 'prInbox:reviewInput',
  prInboxReviewResize: 'prInbox:reviewResize',
  prInboxReviewData: 'prInbox:reviewData',
  prInboxReviewExit: 'prInbox:reviewExit',
  prInboxDraftAdded: 'prInbox:draftAdded'
} as const

export type ChannelName = (typeof Channel)[keyof typeof Channel]

/** Build the stable `${workspaceId}:${tabId}` session id used across the PTY layer. */
export function makeSessionId(workspaceId: string, tabId: string): string {
  return `${workspaceId}:${tabId}`
}
