import type { OtoRun, OtoStartInput } from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

// Thin, mockable seam between the 1:1 store/components and the preload bridge.
export const list = (): Promise<OtoRun[]> => ipc().oneOnOne.list()
export const start = (input: OtoStartInput): Promise<OtoRun> => ipc().oneOnOne.start(input)
export const pickVttFile = (): Promise<string | null> => ipc().oneOnOne.pickVttFile()
export const onRunChanged = (cb: (run: OtoRun) => void): (() => void) =>
  ipc().oneOnOne.onRunChanged(cb)
export const getPathForFile = (file: File): string => ipc().system.getPathForFile(file)
export const openExternal = (url: string): Promise<void> => ipc().system.openExternal(url)
