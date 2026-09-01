import { describe, expect, test } from 'vitest'
import type { ClaudeUsage } from '@common/domain'
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

describe('usage handlers', () => {
  test('get() returns whatever the source currently has', async () => {
    const h = createUsageHandlers({ usage: { get: () => SNAPSHOT, refresh: async () => SNAPSHOT } })
    expect(await h.get()).toEqual(SNAPSHOT)
  })

  test('get() returns null before any snapshot has been captured', async () => {
    const h = createUsageHandlers({ usage: { get: () => null, refresh: async () => null } })
    expect(await h.get()).toBeNull()
  })

  test('refresh() returns the freshest snapshot the source has after querying', async () => {
    const h = createUsageHandlers({ usage: { get: () => SNAPSHOT, refresh: async () => LIVE } })
    expect(await h.refresh()).toEqual(LIVE)
  })
})

describe('usageWireRoutes', () => {
  test('binds both usage channels to their handlers', async () => {
    const h: UsageHandlers = {
      get: () => Promise.resolve(SNAPSHOT),
      refresh: () => Promise.resolve(LIVE)
    }
    const routes = usageWireRoutes(h)

    expect(Object.keys(routes)).toEqual([Channel.usageGet, Channel.usageRefresh])
    expect(await (routes[Channel.usageGet] as () => unknown)()).toEqual(SNAPSHOT)
    expect(await (routes[Channel.usageRefresh] as () => unknown)()).toEqual(LIVE)
  })
})
