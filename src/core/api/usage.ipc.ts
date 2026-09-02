import { type WireRoutes } from '@common/coreBridge'
import { Channel, type IpcApi } from '@common/ipc'
import type { UsageSource } from '../usage/usageSource'

/** The renderer-facing usage surface main implements (onUsageChanged is a preload-side push). */
export type UsageHandlers = Omit<IpcApi['usage'], 'onUsageChanged'>

export interface UsageHandlerDeps {
  usage: Pick<UsageSource, 'get' | 'refresh'>
}

/** Usage handlers: read the freshest snapshot the core holds, or go ask Anthropic for a newer one. */
export function createUsageHandlers(d: UsageHandlerDeps): UsageHandlers {
  return {
    get: () => Promise.resolve(d.usage.get()),
    refresh: () => d.usage.refresh()
  }
}

export function usageWireRoutes(h: UsageHandlers): WireRoutes {
  return {
    [Channel.usageGet]: h.get,
    [Channel.usageRefresh]: h.refresh
  }
}
