import type { IpcMain } from 'electron'
import {
  CORE_INVOKE_CHANNELS,
  CORE_NOTIFY_CHANNELS,
  ELECTRON_ONLY_CHANNELS,
  NATIVE_DOCK_BADGE_PUSH,
  NATIVE_NOTIFICATION_PUSH,
  RENDERER_PUSH_CHANNELS,
  type NativeDockBadgeRequest,
  type NativeNotificationRequest
} from '@common/coreBridge'

/**
 * The whole renderer <-> core bridge in Electron main. Registration is mechanical, driven
 * entirely by the channel classification in coreBridge.ts: forwarded channels get a generic
 * proxy, the Electron-only allowlist gets the explicit native handlers passed in, and core
 * pushes are routed either to the window or to native side effects. Main holds no slice
 * logic anymore.
 */
export interface CoreBridgeDeps {
  ipcMain: Pick<IpcMain, 'handle' | 'on'>
  host: {
    request(channel: string, args: unknown[]): Promise<unknown>
    notify(channel: string, args: unknown[]): void
    onPush(handler: (channel: string, payload: unknown) => void): () => void
  }
  /** One native implementation per ELECTRON_ONLY channel; checked for completeness here. */
  electronOnly: Record<string, (...args: never[]) => unknown>
  sendToRenderer: (channel: string, payload: unknown) => void
  showNotification: (request: NativeNotificationRequest) => void
  setDockBadge: (count: number) => void
}

export function registerCoreBridge(deps: CoreBridgeDeps): void {
  const { ipcMain, host } = deps

  for (const channel of ELECTRON_ONLY_CHANNELS) {
    const handler = deps.electronOnly[channel] as ((...args: unknown[]) => unknown) | undefined
    // Fail at wiring time: an allowlisted channel without a native handler would otherwise
    // surface as a dead button, or worse, fall through to a core that cannot serve it.
    if (!handler) throw new Error(`missing Electron-only handler for ${channel}`)
    ipcMain.handle(channel, (_e, ...args: unknown[]) => handler(...args))
  }

  for (const channel of CORE_INVOKE_CHANNELS) {
    ipcMain.handle(channel, (_e, ...args: unknown[]) => host.request(channel, args))
  }

  for (const channel of CORE_NOTIFY_CHANNELS) {
    ipcMain.on(channel, (_e, ...args: unknown[]) => host.notify(channel, args))
  }

  host.onPush((channel, payload) => {
    if (RENDERER_PUSH_CHANNELS.get(channel as never) === 'core') {
      deps.sendToRenderer(channel, payload)
      return
    }
    if (channel === NATIVE_NOTIFICATION_PUSH) {
      deps.showNotification(payload as NativeNotificationRequest)
      return
    }
    if (channel === NATIVE_DOCK_BADGE_PUSH) {
      deps.setDockBadge((payload as NativeDockBadgeRequest).count)
      return
    }
    console.error(`[bridge] unroutable core push: ${channel}`)
  })
}
