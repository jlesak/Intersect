import { contextBridge, ipcRenderer } from 'electron'
import type { DraftComment } from '@common/domain'
import { Channel, type IpcApi, type TerminalDataEvent, type TerminalExitEvent } from '@common/ipc'

const api: IpcApi = {
  workspaces: {
    getState: () => ipcRenderer.invoke(Channel.workspacesGetState),
    create: (folderPath, name) => ipcRenderer.invoke(Channel.workspacesCreate, folderPath, name),
    rename: (id, name) => ipcRenderer.invoke(Channel.workspacesRename, id, name),
    remove: (id) => ipcRenderer.invoke(Channel.workspacesRemove, id),
    setLayout: (id, layout) => ipcRenderer.invoke(Channel.workspacesSetLayout, id, layout),
    setActive: (id) => ipcRenderer.invoke(Channel.workspacesSetActive, id),
    pickFolder: () => ipcRenderer.invoke(Channel.workspacesPickFolder)
  },
  tabs: {
    listByWorkspace: (wsId) => ipcRenderer.invoke(Channel.tabsListByWorkspace, wsId),
    create: (wsId, preset) => ipcRenderer.invoke(Channel.tabsCreate, wsId, preset),
    rename: (id, title) => ipcRenderer.invoke(Channel.tabsRename, id, title),
    remove: (id) => ipcRenderer.invoke(Channel.tabsRemove, id),
    reorder: (wsId, orderedIds) => ipcRenderer.invoke(Channel.tabsReorder, wsId, orderedIds),
    assignToPane: (id, slot) => ipcRenderer.invoke(Channel.tabsAssignToPane, id, slot),
    setActive: (wsId, tabId) => ipcRenderer.invoke(Channel.tabsSetActive, wsId, tabId)
  },
  terminal: {
    spawn: (sessionId, preset, cwd, cols, rows) =>
      ipcRenderer.invoke(Channel.terminalSpawn, sessionId, preset, cwd, cols, rows),
    write: (sessionId, data) => ipcRenderer.send(Channel.terminalInput, sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send(Channel.terminalResize, sessionId, cols, rows),
    pause: (sessionId) => ipcRenderer.send(Channel.terminalPause, sessionId),
    resume: (sessionId) => ipcRenderer.send(Channel.terminalResume, sessionId),
    kill: (sessionId) => ipcRenderer.send(Channel.terminalKill, sessionId),
    onData: (cb) => {
      const listener = (_e: unknown, msg: TerminalDataEvent): void => cb(msg)
      ipcRenderer.on(Channel.terminalData, listener)
      return () => ipcRenderer.removeListener(Channel.terminalData, listener)
    },
    onExit: (cb) => {
      const listener = (_e: unknown, msg: TerminalExitEvent): void => cb(msg)
      ipcRenderer.on(Channel.terminalExit, listener)
      return () => ipcRenderer.removeListener(Channel.terminalExit, listener)
    }
  },
  prInbox: {
    sync: () => ipcRenderer.invoke(Channel.prInboxSync),
    list: () => ipcRenderer.invoke(Channel.prInboxList),
    getChanges: (repositoryId, prId) => ipcRenderer.invoke(Channel.prInboxGetChanges, repositoryId, prId),
    getFileDiff: (repositoryId, prId, filePath) =>
      ipcRenderer.invoke(Channel.prInboxGetFileDiff, repositoryId, prId, filePath),
    getThreads: (repositoryId, prId) => ipcRenderer.invoke(Channel.prInboxGetThreads, repositoryId, prId),
    listDrafts: (repositoryId, prId) => ipcRenderer.invoke(Channel.prInboxListDrafts, repositoryId, prId),
    addManualDraft: (input) => ipcRenderer.invoke(Channel.prInboxAddManualDraft, input),
    editDraft: (id, body) => ipcRenderer.invoke(Channel.prInboxEditDraft, id, body),
    discardDraft: (id) => ipcRenderer.invoke(Channel.prInboxDiscardDraft, id),
    publishDraft: (id) => ipcRenderer.invoke(Channel.prInboxPublishDraft, id),
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
  }
}

contextBridge.exposeInMainWorld('jarvis', api)
