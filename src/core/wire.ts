import { CORE_INVOKE_CHANNELS, CORE_NOTIFY_CHANNELS, type WireRoutes } from '@common/coreBridge'

/**
 * Compose the slice-local wire contracts into the core's one dispatch table. Slices stay
 * ignorant of each other; a channel served by two slices is a wiring bug and fails the
 * boot loudly instead of silently shadowing one handler.
 */
export function mergeRoutes(...slices: WireRoutes[]): WireRoutes {
  const merged: WireRoutes = {}
  for (const slice of slices) {
    for (const [channel, handler] of Object.entries(slice)) {
      if (merged[channel]) throw new Error(`wire route collision: ${channel}`)
      merged[channel] = handler
    }
  }
  return merged
}

/**
 * The core's request handler: look the channel up and apply the wire args. Unknown channels
 * reject (for requests) or log (for notifications) rather than hanging the caller.
 */
export function createDispatch(
  routes: WireRoutes
): (channel: string, args: unknown[]) => Promise<unknown> {
  return async (channel, args) => {
    const handler = routes[channel] as ((...a: unknown[]) => unknown) | undefined
    if (!handler) throw new Error(`no core handler for channel: ${channel}`)
    return handler(...args)
  }
}

/**
 * Boot-time sanity check: the composed routes must serve exactly the channels the bridge
 * forwards - a missing route would strand a renderer call, an extra one is dead code or a
 * channel that escaped the bridge's classification.
 */
export function assertRoutesCoverBridge(routes: WireRoutes): void {
  const expected = new Set<string>([...CORE_INVOKE_CHANNELS, ...CORE_NOTIFY_CHANNELS])
  const actual = new Set(Object.keys(routes))
  const missing = [...expected].filter((c) => !actual.has(c))
  const extra = [...actual].filter((c) => !expected.has(c))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `core wire routes out of sync with the bridge contract` +
        (missing.length ? `; missing: ${missing.join(', ')}` : '') +
        (extra.length ? `; not bridge channels: ${extra.join(', ')}` : '')
    )
  }
}
