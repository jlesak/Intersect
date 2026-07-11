import { describe, expect, test } from 'vitest'
import type { ClaudeUsage } from '@common/domain'
import { Channel } from '@common/ipc'
import { createUsageHandlers, registerUsageHandlers, type UsageHandlers } from './usage.ipc'

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

describe('registerUsageHandlers', () => {
  test('binds usage:get to the handler', async () => {
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
        registered.set(channel, listener)
      }
    }
    const h: UsageHandlers = { get: () => Promise.resolve(SNAPSHOT) }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerUsageHandlers(ipcMain as any, h)

    expect([...registered.keys()]).toEqual([Channel.usageGet])
    expect(await registered.get(Channel.usageGet)!({})).toEqual(SNAPSHOT)
  })
})
