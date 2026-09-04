import { describe, expect, it, vi } from 'vitest'
import type { ClaudeUsage, UsageLiveConsent } from '@common/domain'
import { createUsageSource } from './usageSource'

function snapshot(capturedAt: number, usedPercent: number): ClaudeUsage {
  return {
    fiveHour: { usedPercent, resetsAt: 1787216400 },
    sevenDay: { usedPercent, resetsAt: 1787504400 },
    capturedAt
  }
}

/** A fake statusline-file service whose content and change notifications the test drives. */
function fakeFile(initial: ClaudeUsage | null) {
  let current = initial
  const listeners: Array<(usage: ClaudeUsage | null) => void> = []
  return {
    file: {
      get: () => current,
      onChange: (cb: (usage: ClaudeUsage | null) => void) => {
        listeners.push(cb)
        return () => {}
      }
    },
    /** Replaces the file content and pushes it, as a real statusline capture would. */
    push(usage: ClaudeUsage | null) {
      current = usage
      for (const l of listeners) l(usage)
    },
    /** Replaces the file content without notifying, as a missed watch event would. */
    setSilently(usage: ClaudeUsage | null) {
      current = usage
    }
  }
}

/** An in-memory consent answer, starting granted so the arbitration tests can query freely. */
function fakeConsent(initial: UsageLiveConsent = 'granted') {
  let value = initial
  return {
    get: () => value,
    set: vi.fn((next: UsageLiveConsent) => {
      value = next
    })
  }
}

const NO_FILE = { get: () => null, onChange: () => () => {} }

describe('createUsageSource: arbitration', () => {
  it('starts from whatever the file already had', () => {
    const { file } = fakeFile(snapshot(1000, 79))
    const source = createUsageSource({ file, fetchLive: async () => null, consent: fakeConsent() })
    expect(source.get()?.capturedAt).toBe(1000)
  })

  it('adopts the live reading on refresh', async () => {
    const { file } = fakeFile(snapshot(1000, 79))
    const source = createUsageSource({
      file,
      fetchLive: async () => snapshot(2000, 29),
      consent: fakeConsent()
    })

    const result = await source.refresh()
    expect(result.usage?.fiveHour?.usedPercent).toBe(29)
    expect(result.live).toBe('ok')
    expect(source.get()?.fiveHour?.usedPercent).toBe(29)
  })

  it('keeps the snapshot it had when the live query has nothing to offer', async () => {
    const { file } = fakeFile(snapshot(1000, 79))
    const source = createUsageSource({ file, fetchLive: async () => null, consent: fakeConsent() })

    const result = await source.refresh()
    expect(result.usage?.capturedAt).toBe(1000)
    expect(result.live).toBe('unavailable')
  })

  it('is not undone by a stale file push arriving after a refresh', async () => {
    const { file, push } = fakeFile(snapshot(1000, 79))
    const source = createUsageSource({
      file,
      fetchLive: async () => snapshot(2000, 29),
      consent: fakeConsent()
    })
    await source.refresh()

    // A statusline capture from before the live reading, pushed late.
    push(snapshot(1500, 79))

    expect(source.get()?.fiveHour?.usedPercent).toBe(29)
  })

  it('adopts a genuinely newer statusline capture over an older live reading', async () => {
    const { file, push } = fakeFile(null)
    const source = createUsageSource({
      file,
      fetchLive: async () => snapshot(2000, 29),
      consent: fakeConsent()
    })
    await source.refresh()

    push(snapshot(3000, 31))

    expect(source.get()?.fiveHour?.usedPercent).toBe(31)
  })

  it('notifies subscribers only when the freshest snapshot actually changes', async () => {
    const { file, push } = fakeFile(snapshot(1000, 79))
    const source = createUsageSource({
      file,
      fetchLive: async () => snapshot(500, 12),
      consent: fakeConsent()
    })
    const cb = vi.fn()
    source.onChange(cb)

    await source.refresh() // older than what we hold, so no change
    expect(cb).not.toHaveBeenCalled()

    push(snapshot(4000, 44))
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(source.get())
  })

  it('still picks up a file change the watcher never announced', () => {
    const { file, setSilently } = fakeFile(null)
    const source = createUsageSource({ file, fetchLive: async () => null, consent: fakeConsent() })

    setSilently(snapshot(1000, 79))

    expect(source.get()?.capturedAt).toBe(1000)
  })

  it('works with no file source at all (statusline tee could not be wired)', async () => {
    const source = createUsageSource({
      file: NO_FILE,
      fetchLive: async () => snapshot(2000, 29),
      consent: fakeConsent()
    })
    expect(source.get()).toBeNull()
    expect((await source.refresh()).usage?.fiveHour?.usedPercent).toBe(29)
  })
})

describe('createUsageSource: the live-query gate', () => {
  it('never calls the live query before the user has been asked', async () => {
    const fetchLive = vi.fn(async () => snapshot(2000, 29))
    const source = createUsageSource({
      file: NO_FILE,
      fetchLive,
      consent: fakeConsent('unasked')
    })

    const result = await source.refresh()

    expect(fetchLive).not.toHaveBeenCalled()
    expect(result).toEqual({ usage: null, live: 'not-allowed' })
    expect(source.consent()).toBe('unasked')
  })

  it('never calls the live query after the user has declined', async () => {
    const fetchLive = vi.fn(async () => snapshot(2000, 29))
    const source = createUsageSource({
      file: NO_FILE,
      fetchLive,
      consent: fakeConsent('declined')
    })

    expect((await source.refresh()).live).toBe('not-allowed')
    expect(fetchLive).not.toHaveBeenCalled()
  })

  it('still serves the statusline snapshot while the live query is barred', async () => {
    const { file } = fakeFile(snapshot(1000, 79))
    const source = createUsageSource({
      file,
      fetchLive: async () => snapshot(2000, 29),
      consent: fakeConsent('unasked')
    })

    const result = await source.refresh()

    expect(result.usage?.capturedAt).toBe(1000)
    expect(result.live).toBe('not-allowed')
  })

  it('records a yes and queries straight away, so the panel fills in at once', async () => {
    const fetchLive = vi.fn(async () => snapshot(2000, 29))
    const consent = fakeConsent('unasked')
    const source = createUsageSource({ file: NO_FILE, fetchLive, consent })

    const result = await source.setConsent(true)

    expect(consent.set).toHaveBeenCalledWith('granted')
    expect(fetchLive).toHaveBeenCalledTimes(1)
    expect(result.live).toBe('ok')
    expect(result.usage?.fiveHour?.usedPercent).toBe(29)
    expect(source.consent()).toBe('granted')
  })

  it('records a no without querying anything', async () => {
    const fetchLive = vi.fn(async () => snapshot(2000, 29))
    const consent = fakeConsent('unasked')
    const source = createUsageSource({ file: NO_FILE, fetchLive, consent })

    const result = await source.setConsent(false)

    expect(consent.set).toHaveBeenCalledWith('declined')
    expect(fetchLive).not.toHaveBeenCalled()
    expect(result).toEqual({ usage: null, live: 'not-allowed' })
    expect(source.consent()).toBe('declined')
  })

  it('lets a user who declined change their mind later', async () => {
    const fetchLive = vi.fn(async () => snapshot(2000, 29))
    const consent = fakeConsent('declined')
    const source = createUsageSource({ file: NO_FILE, fetchLive, consent })

    expect((await source.refresh()).live).toBe('not-allowed')
    expect((await source.setConsent(true)).live).toBe('ok')
    expect((await source.refresh()).live).toBe('ok')
  })

  it('reports unavailable, not ok, when a granted query still comes back empty', async () => {
    const consent = fakeConsent('unasked')
    const source = createUsageSource({ file: NO_FILE, fetchLive: async () => null, consent })

    // What a denied Keychain prompt looks like: consent given, credentials still unreadable.
    const result = await source.setConsent(true)

    expect(consent.set).toHaveBeenCalledWith('granted')
    expect(result).toEqual({ usage: null, live: 'unavailable' })
  })
})
