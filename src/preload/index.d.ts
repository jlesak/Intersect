import type { IpcApi } from '@common/ipc'

declare global {
  interface Window {
    intersect: IpcApi
  }
}

export {}
