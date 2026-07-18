import { describe, expect, test } from 'vitest'
import type { ClaudeUsage } from '@common/domain'
import { Channel } from '@common/ipc'
import { createUsageHandlers, usageWireRoutes, type UsageHandlers } from './usage.ipc'

const SNAPSHOT: ClaudeUsage = {
  fiveHour: { usedPercent: 7, resetsAt: 1774933200 },
  sevenDay: { usedPercent: 53, resetsAt: 1780544400 },
  capturedAt: 1700000000000
}

describe('usage handlers', () => {
  test('get() returns whatever the service currently has', async () => {
    const h = createUsageHandlers({ usage: { get: () => SNAPSHOT } })
    expect(await h.get()).toEqual(SNAPSHOT)
  })

  test('get() returns null before any snapshot has been captured', async () => {
    const h = createUsageHandlers({ usage: { get: () => null } })
    expect(await h.get()).toBeNull()
  })
})

describe('usageWireRoutes', () => {
  test('binds usage:get to the handler', async () => {
    const h: UsageHandlers = { get: () => Promise.resolve(SNAPSHOT) }
    const routes = usageWireRoutes(h)

    expect(Object.keys(routes)).toEqual([Channel.usageGet])
    expect(await (routes[Channel.usageGet] as () => unknown)()).toEqual(SNAPSHOT)
  })
})
