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
  useUsageStore.setState({ usage: null, consent: 'unasked', live: null, refreshing: false }, false)
  vi.clearAllMocks()
  // Most tests care about one call path; the others answer "nothing new" by default. Consent
  // defaults to granted so the refresh tests are not all gated behind answering the question.
  mocked.get.mockResolvedValue(null)
  mocked.liveConsent.mockResolvedValue('granted')
  mocked.refresh.mockResolvedValue({ usage: null, live: 'unavailable' })
  mocked.setConsent.mockResolvedValue({ usage: null, live: 'not-allowed' })
})

describe('hydrate', () => {
  test('applies the snapshot the core reports', async () => {
    mocked.get.mockResolvedValue(snapshot)
    await useUsageStore.getState().hydrate()
    expect(useUsageStore.getState().usage).toEqual(snapshot)
  })

  test('reads the consent answer, which decides whether the panel asks or shows meters', async () => {
    mocked.liveConsent.mockResolvedValue('unasked')
    await useUsageStore.getState().hydrate()
    expect(useUsageStore.getState().consent).toBe('unasked')
  })

  test('follows the cached read with a live query, so boot corrects a stale snapshot', async () => {
    mocked.get.mockResolvedValue(snapshot)
    mocked.refresh.mockResolvedValue({ usage: live, live: 'ok' })
    await useUsageStore.getState().hydrate()
    expect(mocked.refresh).toHaveBeenCalledTimes(1)
    expect(useUsageStore.getState().usage).toEqual(live)
  })

  test('leaves usage null when nothing has been captured yet', async () => {
    mocked.get.mockResolvedValue(null)
    await useUsageStore.getState().hydrate()
    expect(useUsageStore.getState().usage).toBeNull()
  })

  test('leaves usage null when the read fails', async () => {
    mocked.get.mockRejectedValue(new Error('core unavailable'))
    await expect(useUsageStore.getState().hydrate()).resolves.toBeUndefined()
    expect(useUsageStore.getState().usage).toBeNull()
  })

  test('does not query live when the boot read failed', async () => {
    mocked.get.mockRejectedValue(new Error('core unavailable'))
    await useUsageStore.getState().hydrate()
    expect(mocked.refresh).not.toHaveBeenCalled()
  })
})

describe('refresh', () => {
  test('applies the live snapshot the core returns', async () => {
    mocked.refresh.mockResolvedValue({ usage: live, live: 'ok' })
    await useUsageStore.getState().refresh()
    expect(useUsageStore.getState().usage).toEqual(live)
    expect(useUsageStore.getState().live).toBe('ok')
  })

  test('keeps the snapshot it had when the live query offers nothing', async () => {
    useUsageStore.setState({ usage: snapshot }, false)
    mocked.refresh.mockResolvedValue({ usage: null, live: 'unavailable' })
    await useUsageStore.getState().refresh()
    expect(useUsageStore.getState().usage).toEqual(snapshot)
    expect(useUsageStore.getState().live).toBe('unavailable')
  })

  test('records that the core turned the query down for want of consent', async () => {
    mocked.refresh.mockResolvedValue({ usage: null, live: 'not-allowed' })
    await useUsageStore.getState().refresh()
    expect(useUsageStore.getState().live).toBe('not-allowed')
  })

  test('keeps the snapshot it had when the IPC call fails', async () => {
    useUsageStore.setState({ usage: snapshot }, false)
    mocked.refresh.mockRejectedValue(new Error('preload unavailable'))
    await expect(useUsageStore.getState().refresh()).resolves.toBeUndefined()
    expect(useUsageStore.getState().usage).toEqual(snapshot)
  })

  test('flags itself busy while the query is in flight, and clears the flag after', async () => {
    let release: (result: { usage: ClaudeUsage | null; live: 'ok' }) => void = () => {}
    mocked.refresh.mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      })
    )

    const pending = useUsageStore.getState().refresh()
    expect(useUsageStore.getState().refreshing).toBe(true)

    release({ usage: live, live: 'ok' })
    await pending
    expect(useUsageStore.getState().refreshing).toBe(false)
  })

  test('clears the busy flag even when the query fails', async () => {
    mocked.refresh.mockRejectedValue(new Error('offline'))
    await useUsageStore.getState().refresh()
    expect(useUsageStore.getState().refreshing).toBe(false)
  })
})

describe('setConsent', () => {
  test('a yes is recorded and applies the snapshot the immediate query returns', async () => {
    mocked.setConsent.mockResolvedValue({ usage: live, live: 'ok' })
    await useUsageStore.getState().setConsent(true)

    expect(mocked.setConsent).toHaveBeenCalledWith(true)
    expect(useUsageStore.getState().consent).toBe('granted')
    expect(useUsageStore.getState().usage).toEqual(live)
    expect(useUsageStore.getState().live).toBe('ok')
  })

  test('a no is recorded and queries nothing', async () => {
    await useUsageStore.getState().setConsent(false)

    expect(mocked.setConsent).toHaveBeenCalledWith(false)
    expect(useUsageStore.getState().consent).toBe('declined')
    expect(mocked.refresh).not.toHaveBeenCalled()
  })

  test('closes the question on the click, before the round trip finishes', async () => {
    let release: (result: { usage: ClaudeUsage | null; live: 'ok' }) => void = () => {}
    mocked.setConsent.mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      })
    )

    const pending = useUsageStore.getState().setConsent(true)
    // The OS credentials prompt happens inside this window; the question must not still be up.
    expect(useUsageStore.getState().consent).toBe('granted')
    expect(useUsageStore.getState().refreshing).toBe(true)

    release({ usage: live, live: 'ok' })
    await pending
    expect(useUsageStore.getState().refreshing).toBe(false)
  })

  test('a no shows no busy state, since nothing is queried', async () => {
    const pending = useUsageStore.getState().setConsent(false)
    expect(useUsageStore.getState().refreshing).toBe(false)
    await pending
  })

  test('reports unavailable when consent was granted but the query still came back empty', async () => {
    mocked.setConsent.mockResolvedValue({ usage: null, live: 'unavailable' })
    await useUsageStore.getState().setConsent(true)

    expect(useUsageStore.getState().consent).toBe('granted')
    expect(useUsageStore.getState().live).toBe('unavailable')
  })

  test('keeps the answer as clicked when the round trip fails', async () => {
    mocked.setConsent.mockRejectedValue(new Error('core unavailable'))
    await expect(useUsageStore.getState().setConsent(true)).resolves.toBeUndefined()

    expect(useUsageStore.getState().consent).toBe('granted')
    expect(useUsageStore.getState().refreshing).toBe(false)
  })

  test('a user who declined can change their mind', async () => {
    await useUsageStore.getState().setConsent(false)
    expect(useUsageStore.getState().consent).toBe('declined')

    mocked.setConsent.mockResolvedValue({ usage: live, live: 'ok' })
    await useUsageStore.getState().setConsent(true)
    expect(useUsageStore.getState().consent).toBe('granted')
    expect(useUsageStore.getState().usage).toEqual(live)
  })
})

describe('subscribe', () => {
  test('applies a pushed snapshot to the store', () => {
    let pushed: ((usage: ClaudeUsage | null) => void) | undefined
    mocked.onUsageChanged.mockImplementation((cb) => {
      pushed = cb
      return () => {}
    })

    useUsageStore.getState().subscribe()
    pushed?.(snapshot)

    expect(useUsageStore.getState().usage).toEqual(snapshot)
  })

  test('returns the unsubscribe fn the bridge handed back', () => {
    const off = vi.fn()
    mocked.onUsageChanged.mockReturnValue(off)

    useUsageStore.getState().subscribe()()

    expect(off).toHaveBeenCalledTimes(1)
  })
})
