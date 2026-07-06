import type { JiraBoardResult, JiraLoginResult } from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

// Thin, mockable seam between the My Work store and the preload bridge.
export const list = (): Promise<JiraBoardResult> => ipc().myWork.list()
export const refresh = (): Promise<JiraBoardResult> => ipc().myWork.refresh()
export const login = (): Promise<JiraLoginResult> => ipc().myWork.login()
export const openExternal = (url: string): Promise<void> => ipc().system.openExternal(url)
