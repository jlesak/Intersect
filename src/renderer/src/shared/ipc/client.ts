import type { IpcApi } from '@common/ipc'

/**
 * Typed accessor for the preload-exposed bridge. All renderer IPC goes through here, so the
 * renderer never touches ipcRenderer directly and slice ipc modules stay thin and mockable.
 */
export function ipc(): IpcApi {
  const api = (window as unknown as { intersect?: IpcApi }).intersect
  if (!api) throw new Error('window.intersect is unavailable - preload did not load')
  return api
}

/**
 * Whether the preload bridge attached at all, answered without constructing a call. The crash
 * fallback needs this: it must decide whether an IPC-backed action is worth offering while it is
 * itself the last surface on screen, and `ipc()` throwing there would leave a blank window.
 */
export function hasIpcBridge(): boolean {
  return Boolean((window as unknown as { intersect?: IpcApi }).intersect)
}
