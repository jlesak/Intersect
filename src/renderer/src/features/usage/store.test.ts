import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ClaudeUsage } from '@common/domain'

vi.mock('./ipc')
import * as api from './ipc'
import { useUsageStore } from './store'

const mocked = vi.mocked(api)

const snapshot: ClaudeUsage = {
  fiveHour: { usedPercent: 7, resetsAt: 1774933200 },
  sevenDay: { usedPercent: 53, resetsAt: 1780544400 },
  capturedAt: 1700000000000
}

beforeEach(() => {
  useUsageStore.setState({ usage: null }, false)
  vi.clearAllMocks()
})

describe('hydrate', () => {
  test('fetches the current snapshot', async () => {
    mocked.get.mockResolvedValue(snapshot)
    await useUsageStore.getState().hydrate()
    expect(useUsageStore.getState().usage).toEqual(snapshot)
  })

  test('leaves usage null when nothing has been captured yet', async () => {
    mocked.get.mockResolvedValue(null)
    await useUsageStore.getState().hydrate()
    expect(useUsageStore.getState().usage).toBeNull()
  })

  test('falls back to null (never throws) when the IPC call fails', async () => {
    mocked.get.mockRejectedValue(new Error('preload unavailable'))
    await expect(useUsageStore.getState().hydrate()).resolves.toBeUndefined()
    expect(useUsageStore.getState().usage).toBeNull()
  })
})

describe('subscribe', () => {
  test('applies a pushed snapshot to the store', () => {
    let pushed: ((usage: ClaudeUsage | null) => void) | undefined
    mocked.onUsageChanged.mockImplementation((cb) => {
      pushed = cb
      return () => {}
    })

    const unsubscribe = useUsageStore.getState().subscribe()
    expect(mocked.onUsageChanged).toHaveBeenCalledTimes(1)

    pushed?.(snapshot)
    expect(useUsageStore.getState().usage).toEqual(snapshot)

    unsubscribe()
  })

  test('returns the ipc layer own unsubscribe fn', () => {
    const fakeUnsubscribe = vi.fn()
    mocked.onUsageChanged.mockReturnValue(fakeUnsubscribe)

    const unsubscribe = useUsageStore.getState().subscribe()
    unsubscribe()
    expect(fakeUnsubscribe).toHaveBeenCalledTimes(1)
  })
})
