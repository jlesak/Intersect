import type { IpcApi } from '@common/ipc'

declare global {
  interface Window {
    jarvis: IpcApi
  }
}

export {}
