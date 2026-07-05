import { contextBridge, ipcRenderer } from 'electron'
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
  }
}

contextBridge.exposeInMainWorld('jarvis', api)
