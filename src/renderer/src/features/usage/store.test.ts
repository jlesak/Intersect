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

const live: ClaudeUsage = {
  fiveHour: { usedPercent: 29, resetsAt: 1787616000 },
  sevenDay: { usedPercent: 6, resetsAt: 1788148800 },
  capturedAt: 1787600000000
}

beforeEach(() => {
  useUsageStore.setState({ usage: null, refreshing: false }, false)
  vi.clearAllMocks()
  // Most tests care about one call path; the other resolves to "nothing new" by default.
  mocked.get.mockResolvedValue(null)
  mocked.refresh.mockResolvedValue(null)
})

describe('hydrate', () => {
  test('fetches the current snapshot', async () => {
    mocked.get.mockResolvedValue(snapshot)
    await useUsageStore.getState().hydrate()
    expect(useUsageStore.getState().usage).toEqual(snapshot)
  })

  test('follows the cached read with a live query, so boot corrects a stale snapshot', async () => {
    mocked.get.mockResolvedValue(snapshot)
    mocked.refresh.mockResolvedValue(live)
    await useUsageStore.getState().hydrate()
    expect(mocked.refresh).toHaveBeenCalledTimes(1)
    expect(useUsageStore.getState().usage).toEqual(live)
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

describe('refresh', () => {
  test('applies the live snapshot the core returns', async () => {
    mocked.refresh.mockResolvedValue(live)
    await useUsageStore.getState().refresh()
    expect(useUsageStore.getState().usage).toEqual(live)
  })

  test('keeps the snapshot it had when the live query offers nothing', async () => {
    useUsageStore.setState({ usage: snapshot }, false)
    mocked.refresh.mockResolvedValue(null)
    await useUsageStore.getState().refresh()
    expect(useUsageStore.getState().usage).toEqual(snapshot)
  })

  test('keeps the snapshot it had when the IPC call fails', async () => {
    useUsageStore.setState({ usage: snapshot }, false)
    mocked.refresh.mockRejectedValue(new Error('preload unavailable'))
    await expect(useUsageStore.getState().refresh()).resolves.toBeUndefined()
    expect(useUsageStore.getState().usage).toEqual(snapshot)
  })

  test('flags itself busy while the query is in flight, and clears the flag after', async () => {
    let release: (usage: ClaudeUsage | null) => void = () => {}
    mocked.refresh.mockReturnValue(
      new Promise<ClaudeUsage | null>((resolve) => {
        release = resolve
      })
    )

    const pending = useUsageStore.getState().refresh()
    expect(useUsageStore.getState().refreshing).toBe(true)

    release(live)
    await pending
    expect(useUsageStore.getState().refreshing).toBe(false)
  })

  test('clears the busy flag even when the query fails', async () => {
    mocked.refresh.mockRejectedValue(new Error('offline'))
    await useUsageStore.getState().refresh()
    expect(useUsageStore.getState().refreshing).toBe(false)
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
