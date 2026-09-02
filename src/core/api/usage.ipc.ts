import { type WireRoutes } from '@common/coreBridge'
import { Channel, type IpcApi } from '@common/ipc'
import type { UsageSource } from '../usage/usageSource'

/** The renderer-facing usage surface main implements (onUsageChanged is a preload-side push). */
export type UsageHandlers = Omit<IpcApi['usage'], 'onUsageChanged'>

export interface UsageHandlerDeps {
  usage: Pick<UsageSource, 'get' | 'refresh' | 'consent' | 'setConsent'>
}

/**
 * Usage handlers: read the freshest snapshot the core holds, go ask Anthropic for a newer one, and
 * read or record whether asking is allowed at all.
 */
export function createUsageHandlers(d: UsageHandlerDeps): UsageHandlers {
  return {
    get: () => Promise.resolve(d.usage.get()),
    refresh: () => d.usage.refresh(),
    liveConsent: () => Promise.resolve(d.usage.consent()),
    setLiveConsent: (granted) => d.usage.setConsent(granted)
  }
}

export function usageWireRoutes(h: UsageHandlers): WireRoutes {
  return {
    [Channel.usageGet]: h.get,
    [Channel.usageRefresh]: h.refresh,
    [Channel.usageLiveConsent]: h.liveConsent,
    [Channel.usageSetLiveConsent]: h.setLiveConsent
  }
}
