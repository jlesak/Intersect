import { ipc } from '@renderer/shared/ipc/client'

// Thin, mockable seam between the palette store and the preload bridge.
export const getRecent = (): Promise<string[]> => ipc().palette.getRecent()
export const recordUse = (commandId: string): Promise<string[]> =>
  ipc().palette.recordUse(commandId)
