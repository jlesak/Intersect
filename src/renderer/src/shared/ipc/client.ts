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
