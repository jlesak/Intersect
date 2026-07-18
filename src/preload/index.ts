import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ClaudeUsage, DraftComment, OtoRun } from '@common/domain'
import {
  Channel,
  type CoreStatus,
  type IpcApi,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalNotificationClickEvent,
  type TerminalSessionStatusEvent
} from '@common/ipc'

const api: IpcApi = {
  workspaces: {
    getState: () => ipcRenderer.invoke(Channel.workspacesGetState),
    create: (folderPath, name) => ipcRenderer.invoke(Channel.workspacesCreate, folderPath, name),
    rename: (id, name) => ipcRenderer.invoke(Channel.workspacesRename, id, name),
    remove: (id) => ipcRenderer.invoke(Channel.workspacesRemove, id),
    setLayout: (id, layout) => ipcRenderer.invoke(Channel.workspacesSetLayout, id, layout),
    setActive: (id) => ipcRenderer.invoke(Channel.workspacesSetActive, id),
    pickFolder: () => ipcRenderer.invoke(Channel.workspacesPickFolder),
    assignProject: (id, projectId) =>
      ipcRenderer.invoke(Channel.workspacesAssignProject, id, projectId),
    autoAssignProject: (id) => ipcRenderer.invoke(Channel.workspacesAutoAssignProject, id)
  },
  projects: {
    list: () => ipcRenderer.invoke(Channel.projectsList),
    create: (name, folderPath) => ipcRenderer.invoke(Channel.projectsCreate, name, folderPath),
    update: (id, patch) => ipcRenderer.invoke(Channel.projectsUpdate, id, patch),
    setArchived: (id, archived) => ipcRenderer.invoke(Channel.projectsSetArchived, id, archived),
    reorder: (orderedIds) => ipcRenderer.invoke(Channel.projectsReorder, orderedIds),
    remove: (id) => ipcRenderer.invoke(Channel.projectsRemove, id),
    addRepoPath: (id, folderPath) => ipcRenderer.invoke(Channel.projectsAddRepoPath, id, folderPath),
    removeRepoPath: (id, folderPath) =>
      ipcRenderer.invoke(Channel.projectsRemoveRepoPath, id, folderPath),
    resolvePath: (path) => ipcRenderer.invoke(Channel.projectsResolvePath, path),
    listOverrides: () => ipcRenderer.invoke(Channel.projectsListOverrides),
    setOverride: (kind, key, projectId) =>
      ipcRenderer.invoke(Channel.projectsSetOverride, kind, key, projectId),
    clearOverride: (kind, key) => ipcRenderer.invoke(Channel.projectsClearOverride, kind, key),
    listWorktrees: (id) => ipcRenderer.invoke(Channel.projectsListWorktrees, id),
    getTerminalLayouts: (projectKey) =>
      ipcRenderer.invoke(Channel.projectsGetTerminalLayouts, projectKey),
    setTerminalLayout: (projectKey, layout, shares) =>
      ipcRenderer.invoke(Channel.projectsSetTerminalLayout, projectKey, layout, shares)
  },
  tabs: {
    listByWorkspace: (wsId) => ipcRenderer.invoke(Channel.tabsListByWorkspace, wsId),
    create: (wsId, preset, resumeSessionId) =>
      ipcRenderer.invoke(Channel.tabsCreate, wsId, preset, resumeSessionId ?? null),
    rename: (id, title) => ipcRenderer.invoke(Channel.tabsRename, id, title),
    remove: (id) => ipcRenderer.invoke(Channel.tabsRemove, id),
    reorder: (wsId, orderedIds) => ipcRenderer.invoke(Channel.tabsReorder, wsId, orderedIds),
    assignToPane: (id, slot) => ipcRenderer.invoke(Channel.tabsAssignToPane, id, slot),
    setActive: (wsId, tabId) => ipcRenderer.invoke(Channel.tabsSetActive, wsId, tabId)
  },
  terminal: {
    spawn: (sessionId, preset, cwd, cols, rows, resumeSessionId) =>
      ipcRenderer.invoke(Channel.terminalSpawn, sessionId, preset, cwd, cols, rows, resumeSessionId ?? null),
    attach: (sessionId) => ipcRenderer.invoke(Channel.terminalAttach, sessionId),
    write: (sessionId, data) => ipcRenderer.send(Channel.terminalInput, sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send(Channel.terminalResize, sessionId, cols, rows),
    pause: (sessionId) => ipcRenderer.send(Channel.terminalPause, sessionId),
    resume: (sessionId) => ipcRenderer.send(Channel.terminalResume, sessionId),
    kill: (sessionId) => ipcRenderer.send(Channel.terminalKill, sessionId),
    reportActiveSession: (sessionId) => ipcRenderer.send(Channel.terminalReportActive, sessionId),
    onData: (cb) => {
      const listener = (_e: unknown, msg: TerminalDataEvent): void => cb(msg)
      ipcRenderer.on(Channel.terminalData, listener)
      return () => ipcRenderer.removeListener(Channel.terminalData, listener)
    },
    onExit: (cb) => {
      const listener = (_e: unknown, msg: TerminalExitEvent): void => cb(msg)
      ipcRenderer.on(Channel.terminalExit, listener)
      return () => ipcRenderer.removeListener(Channel.terminalExit, listener)
    },
    onSessionStatus: (cb) => {
      const listener = (_e: unknown, msg: TerminalSessionStatusEvent): void => cb(msg)
      ipcRenderer.on(Channel.terminalSessionStatus, listener)
      return () => ipcRenderer.removeListener(Channel.terminalSessionStatus, listener)
    },
    onNotificationClicked: (cb) => {
      const listener = (_e: unknown, msg: TerminalNotificationClickEvent): void => cb(msg)
      ipcRenderer.on(Channel.terminalNotificationClicked, listener)
      return () => ipcRenderer.removeListener(Channel.terminalNotificationClicked, listener)
    }
  },
  prInbox: {
    sync: () => ipcRenderer.invoke(Channel.prInboxSync),
    list: () => ipcRenderer.invoke(Channel.prInboxList),
    getChanges: (repositoryId, prId) => ipcRenderer.invoke(Channel.prInboxGetChanges, repositoryId, prId),
    getFileDiff: (repositoryId, prId, filePath) =>
      ipcRenderer.invoke(Channel.prInboxGetFileDiff, repositoryId, prId, filePath),
    getThreads: (repositoryId, prId) => ipcRenderer.invoke(Channel.prInboxGetThreads, repositoryId, prId),
    addComment: (input) => ipcRenderer.invoke(Channel.prInboxAddComment, input),
    replyToThread: (repositoryId, prId, threadId, body) =>
      ipcRenderer.invoke(Channel.prInboxReplyToThread, repositoryId, prId, threadId, body),
    setThreadStatus: (repositoryId, prId, threadId, status) =>
      ipcRenderer.invoke(Channel.prInboxSetThreadStatus, repositoryId, prId, threadId, status),
    listDrafts: (repositoryId, prId) => ipcRenderer.invoke(Channel.prInboxListDrafts, repositoryId, prId),
    addManualDraft: (input) => ipcRenderer.invoke(Channel.prInboxAddManualDraft, input),
    editDraft: (id, body) => ipcRenderer.invoke(Channel.prInboxEditDraft, id, body),
    discardDraft: (id) => ipcRenderer.invoke(Channel.prInboxDiscardDraft, id),
    publishDraft: (id) => ipcRenderer.invoke(Channel.prInboxPublishDraft, id),
    castVote: (repositoryId, prId, vote) =>
      ipcRenderer.invoke(Channel.prInboxCastVote, repositoryId, prId, vote),
    startReview: (repositoryId, prId) => ipcRenderer.invoke(Channel.prInboxStartReview, repositoryId, prId),
    endReview: () => ipcRenderer.invoke(Channel.prInboxEndReview),
    reviewInput: (data) => ipcRenderer.send(Channel.prInboxReviewInput, data),
    reviewResize: (cols, rows) => ipcRenderer.send(Channel.prInboxReviewResize, cols, rows),
    onReviewData: (cb) => {
      const listener = (_e: unknown, data: string): void => cb(data)
      ipcRenderer.on(Channel.prInboxReviewData, listener)
      return () => ipcRenderer.removeListener(Channel.prInboxReviewData, listener)
    },
    onReviewExit: (cb) => {
      const listener = (_e: unknown, exitCode: number): void => cb(exitCode)
      ipcRenderer.on(Channel.prInboxReviewExit, listener)
      return () => ipcRenderer.removeListener(Channel.prInboxReviewExit, listener)
    },
    onDraftAdded: (cb) => {
      const listener = (_e: unknown, draft: DraftComment): void => cb(draft)
      ipcRenderer.on(Channel.prInboxDraftAdded, listener)
      return () => ipcRenderer.removeListener(Channel.prInboxDraftAdded, listener)
    }
  },
  sessions: {
    list: () => ipcRenderer.invoke(Channel.sessionsList),
    refresh: () => ipcRenderer.invoke(Channel.sessionsRefresh),
    getTranscript: (id) => ipcRenderer.invoke(Channel.sessionsGetTranscript, id)
  },
  timeTracking: {
    getWeek: (weekStart) => ipcRenderer.invoke(Channel.timeTrackingGetWeek, weekStart),
    refreshWeek: (weekStart) => ipcRenderer.invoke(Channel.timeTrackingRefreshWeek, weekStart),
    addManual: (input) => ipcRenderer.invoke(Channel.timeTrackingAddManual, input),
    updateEntry: (source, id, update) =>
      ipcRenderer.invoke(Channel.timeTrackingUpdateEntry, source, id, update),
    deleteEntry: (source, id) => ipcRenderer.invoke(Channel.timeTrackingDeleteEntry, source, id)
  },
  todo: {
    list: () => ipcRenderer.invoke(Channel.todoList),
    add: (text, dueDay) => ipcRenderer.invoke(Channel.todoAdd, text, dueDay),
    update: (id, patch) => ipcRenderer.invoke(Channel.todoUpdate, id, patch),
    setDone: (id, done) => ipcRenderer.invoke(Channel.todoSetDone, id, done),
    remove: (id) => ipcRenderer.invoke(Channel.todoRemove, id),
    reorder: (orderedIds) => ipcRenderer.invoke(Channel.todoReorder, orderedIds)
  },
  myWork: {
    list: () => ipcRenderer.invoke(Channel.myWorkList),
    refresh: () => ipcRenderer.invoke(Channel.myWorkRefresh),
    login: () => ipcRenderer.invoke(Channel.myWorkLogin)
  },
  oneOnOne: {
    list: () => ipcRenderer.invoke(Channel.oneOnOneList),
    start: (input) => ipcRenderer.invoke(Channel.oneOnOneStart, input),
    pickVttFile: () => ipcRenderer.invoke(Channel.oneOnOnePickVtt),
    onRunChanged: (cb) => {
      const listener = (_e: unknown, run: OtoRun): void => cb(run)
      ipcRenderer.on(Channel.oneOnOneRunChanged, listener)
      return () => ipcRenderer.removeListener(Channel.oneOnOneRunChanged, listener)
    }
  },
  settings: {
    get: () => ipcRenderer.invoke(Channel.settingsGet),
    setNotifications: (notifications) =>
      ipcRenderer.invoke(Channel.settingsSetNotifications, notifications),
    setAdo: (ado) => ipcRenderer.invoke(Channel.settingsSetAdo, ado),
    setTerminalFontSize: (px) => ipcRenderer.invoke(Channel.settingsSetTerminalFontSize, px),
    setReview: (review) => ipcRenderer.invoke(Channel.settingsSetReview, review),
    testAdoConnection: (ado) => ipcRenderer.invoke(Channel.settingsTestAdoConnection, ado)
  },
  system: {
    openExternal: (url) => ipcRenderer.invoke(Channel.systemOpenExternal, url),
    // webUtils only exists in preload; the renderer needs it to turn a dropped File into a path.
    getPathForFile: (file) => webUtils.getPathForFile(file),
    restartApp: () => ipcRenderer.invoke(Channel.systemRestartApp),
    retryCore: () => ipcRenderer.invoke(Channel.systemRetryCore),
    quitApp: () => ipcRenderer.invoke(Channel.systemQuitApp),
    onCoreStatus: (cb) => {
      const listener = (_e: unknown, status: CoreStatus): void => cb(status)
      ipcRenderer.on(Channel.systemCoreStatus, listener)
      return () => ipcRenderer.removeListener(Channel.systemCoreStatus, listener)
    }
  },
  usage: {
    get: () => ipcRenderer.invoke(Channel.usageGet),
    onUsageChanged: (cb) => {
      const listener = (_e: unknown, usage: ClaudeUsage | null): void => cb(usage)
      ipcRenderer.on(Channel.usageChanged, listener)
      return () => ipcRenderer.removeListener(Channel.usageChanged, listener)
    }
  }
}

contextBridge.exposeInMainWorld('intersect', api)
