import { describe, expect, test, vi } from 'vitest'
import type { ClaudeUsage, UsageLiveConsent, UsageRefresh } from '@common/domain'
import { Channel } from '@common/ipc'
import { createUsageHandlers, usageWireRoutes, type UsageHandlers } from './usage.ipc'

const SNAPSHOT: ClaudeUsage = {
  fiveHour: { usedPercent: 7, resetsAt: 1774933200 },
  sevenDay: { usedPercent: 53, resetsAt: 1780544400 },
  capturedAt: 1700000000000
}

const LIVE: ClaudeUsage = {
  fiveHour: { usedPercent: 29, resetsAt: 1787616000 },
  sevenDay: { usedPercent: 6, resetsAt: 1788148800 },
  capturedAt: 1787600000000
}

/** A usage source stub with every method the handlers reach for. */
function source(over: {
  get?: () => ClaudeUsage | null
  refresh?: () => Promise<UsageRefresh>
  consent?: () => UsageLiveConsent
  setConsent?: (granted: boolean) => Promise<UsageRefresh>
}) {
  return {
    get: over.get ?? (() => SNAPSHOT),
    refresh: over.refresh ?? (async () => ({ usage: SNAPSHOT, live: 'ok' as const })),
    consent: over.consent ?? (() => 'granted' as const),
    setConsent: over.setConsent ?? (async () => ({ usage: SNAPSHOT, live: 'ok' as const }))
  }
}

describe('usage handlers', () => {
  test('get() returns whatever the source currently has', async () => {
    const h = createUsageHandlers({ usage: source({}) })
    expect(await h.get()).toEqual(SNAPSHOT)
  })

  test('get() returns null before any snapshot has been captured', async () => {
    const h = createUsageHandlers({ usage: source({ get: () => null }) })
    expect(await h.get()).toBeNull()
  })

  test('refresh() returns the freshest snapshot and how the query went', async () => {
    const h = createUsageHandlers({
      usage: source({ refresh: async () => ({ usage: LIVE, live: 'ok' }) })
    })
    expect(await h.refresh()).toEqual({ usage: LIVE, live: 'ok' })
  })

  test('refresh() passes an unavailable query through rather than reading it as success', async () => {
    const h = createUsageHandlers({
      usage: source({ refresh: async () => ({ usage: SNAPSHOT, live: 'unavailable' }) })
    })
    expect(await h.refresh()).toEqual({ usage: SNAPSHOT, live: 'unavailable' })
  })

  test('liveConsent() reports the answer the source holds', async () => {
    const h = createUsageHandlers({ usage: source({ consent: () => 'unasked' }) })
    expect(await h.liveConsent()).toBe('unasked')
  })

  test('setLiveConsent() forwards the answer and returns the resulting query', async () => {
    const setConsent = vi.fn(async () => ({ usage: LIVE, live: 'ok' as const }))
    const h = createUsageHandlers({ usage: source({ setConsent }) })

    expect(await h.setLiveConsent(true)).toEqual({ usage: LIVE, live: 'ok' })
    expect(setConsent).toHaveBeenCalledWith(true)
  })

  test('setLiveConsent() forwards a no as a no', async () => {
    const setConsent = vi.fn(async () => ({ usage: null, live: 'not-allowed' as const }))
    const h = createUsageHandlers({ usage: source({ setConsent }) })

    expect(await h.setLiveConsent(false)).toEqual({ usage: null, live: 'not-allowed' })
    expect(setConsent).toHaveBeenCalledWith(false)
  })
})

describe('usageWireRoutes', () => {
  test('binds every usage channel to its handler', async () => {
    const h: UsageHandlers = {
      get: () => Promise.resolve(SNAPSHOT),
      refresh: () => Promise.resolve({ usage: LIVE, live: 'ok' }),
      liveConsent: () => Promise.resolve('granted'),
      setLiveConsent: (granted) => Promise.resolve({ usage: granted ? LIVE : null, live: 'ok' })
    }
    const routes = usageWireRoutes(h)

    expect(Object.keys(routes)).toEqual([
      Channel.usageGet,
      Channel.usageRefresh,
      Channel.usageLiveConsent,
      Channel.usageSetLiveConsent
    ])
    expect(await (routes[Channel.usageGet] as () => unknown)()).toEqual(SNAPSHOT)
    expect(await (routes[Channel.usageRefresh] as () => unknown)()).toEqual({
      usage: LIVE,
      live: 'ok'
    })
    expect(await (routes[Channel.usageLiveConsent] as () => unknown)()).toBe('granted')
    expect(
      await (routes[Channel.usageSetLiveConsent] as (g: boolean) => unknown)(true)
    ).toEqual({ usage: LIVE, live: 'ok' })
  })
})
