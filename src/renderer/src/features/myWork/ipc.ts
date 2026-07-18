import type { JiraBoardSnapshot, JiraLoginResult } from '@common/domain'
import type { MyWorkChangedEvent } from '@common/ipc'
import { ipc } from '@renderer/shared/ipc/client'

// Thin, mockable seam between the My Work store and the preload bridge.
export const list = (): Promise<JiraBoardSnapshot> => ipc().myWork.list()
export const refresh = (): Promise<JiraBoardSnapshot> => ipc().myWork.refresh()
export const login = (): Promise<JiraLoginResult> => ipc().myWork.login()
export const projectBoard = (projectId: string): Promise<JiraBoardSnapshot> =>
  ipc().myWork.projectBoard(projectId)
export const refreshProject = (projectId: string): Promise<JiraBoardSnapshot> =>
  ipc().myWork.refreshProject(projectId)
export const onChanged = (cb: (event: MyWorkChangedEvent) => void): (() => void) =>
  ipc().myWork.onChanged(cb)
export const openExternal = (url: string): Promise<void> => ipc().system.openExternal(url)
