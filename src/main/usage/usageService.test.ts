import { describe, expect, it, vi } from 'vitest'
import type { UsageServiceFs } from './usageService'
import { createUsageService } from './usageService'

const SNAPSHOT_PATH = '/data/userData/claude-usage.json'

/** A fake fs.watch/readFileSync pair: readFileSync serves whatever content was last set, and
 *  watch's registered listeners fire only when trigger() is called (never on their own). */
function fakeFs(initialContent: string | null): {
  fs: UsageServiceFs
  setContent(content: string | null): void
  trigger(): void
  closeWatcher: ReturnType<typeof vi.fn>
} {
  let content = initialContent
  const listeners: Array<() => void> = []
  const closeWatcher = vi.fn()
  return {
    fs: {
      readFileSync: () => {
        if (content === null) throw new Error('ENOENT: no such file')
        return content
      },
      watch: (_dir, listener) => {
        listeners.push(listener)
        return { close: closeWatcher } as unknown as ReturnType<UsageServiceFs['watch']>
      }
    },
    setContent(c) {
      content = c
    },
    trigger() {
      for (const l of listeners) l()
    },
    closeWatcher
  }
}

const validSnapshot = JSON.stringify({
  rateLimits: {
    five_hour: { used_percentage: 7, resets_at: 1774933200 },
    seven_day: { used_percentage: 53, resets_at: 1780544400 }
  },
  capturedAt: 1700000000000
})

describe('createUsageService: initial read', () => {
  it('maps a valid snapshot into the renderer-facing ClaudeUsage contract', () => {
    const { fs } = fakeFs(validSnapshot)
    const service = createUsageService({ snapshotPath: SNAPSHOT_PATH, fs })
    expect(service.get()).toEqual({
      fiveHour: { usedPercent: 7, resetsAt: 1774933200 },
      sevenDay: { usedPercent: 53, resetsAt: 1780544400 },
      capturedAt: 1700000000000
    })
  })

  it('returns null when the snapshot file does not exist yet', () => {
    const { fs } = fakeFs(null)
    const service = createUsageService({ snapshotPath: SNAPSHOT_PATH, fs })
    expect(service.get()).toBeNull()
  })

  it('returns null (never throws) for malformed JSON', () => {
    const { fs } = fakeFs('not json at all {{{')
    const service = createUsageService({ snapshotPath: SNAPSHOT_PATH, fs })
    expect(service.get()).toBeNull()
  })

  it('returns null when capturedAt is missing (unrecognised shape)', () => {
    const { fs } = fakeFs(JSON.stringify({ rateLimits: null }))
    const service = createUsageService({ snapshotPath: SNAPSHOT_PATH, fs })
    expect(service.get()).toBeNull()
  })

  it('treats a rateLimits window with the wrong field types as absent (non-subscription shape)', () => {
    const { fs } = fakeFs(
      JSON.stringify({ rateLimits: { five_hour: { used_percentage: 'oops' } }, capturedAt: 5 })
    )
    const service = createUsageService({ snapshotPath: SNAPSHOT_PATH, fs })
    expect(service.get()).toEqual({ fiveHour: null, sevenDay: null, capturedAt: 5 })
  })

  it('reports both windows null when rateLimits itself is null (non-subscription user)', () => {
    const { fs } = fakeFs(JSON.stringify({ rateLimits: null, capturedAt: 123 }))
    const service = createUsageService({ snapshotPath: SNAPSHOT_PATH, fs })
    expect(service.get()).toEqual({ fiveHour: null, sevenDay: null, capturedAt: 123 })
  })
})

describe('createUsageService: change detection', () => {
  it('re-reads and notifies subscribers once the debounce settles after a directory watch event', async () => {
    const { fs, setContent, trigger } = fakeFs(null)
    const service = createUsageService({ snapshotPath: SNAPSHOT_PATH, fs, debounceMs: 5 })
    expect(service.get()).toBeNull()

    const cb = vi.fn()
    service.onChange(cb)

    setContent(validSnapshot)
    trigger()
    await new Promise((r) => setTimeout(r, 30))

    expect(service.get()).toEqual({
      fiveHour: { usedPercent: 7, resetsAt: 1774933200 },
      sevenDay: { usedPercent: 53, resetsAt: 1780544400 },
      capturedAt: 1700000000000
    })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(service.get())
  })

  it('collapses a burst of watch events into a single re-read/notify', async () => {
    const { fs, setContent, trigger } = fakeFs(null)
    const service = createUsageService({ snapshotPath: SNAPSHOT_PATH, fs, debounceMs: 20 })
    const cb = vi.fn()
    service.onChange(cb)

    setContent(validSnapshot)
    trigger()
    trigger()
    trigger()
    await new Promise((r) => setTimeout(r, 40))

    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('an unsubscribed listener stops receiving further notifications', async () => {
    const { fs, setContent, trigger } = fakeFs(null)
    const service = createUsageService({ snapshotPath: SNAPSHOT_PATH, fs, debounceMs: 5 })
    const cb = vi.fn()
    const unsubscribe = service.onChange(cb)
    unsubscribe()

    setContent(validSnapshot)
    trigger()
    await new Promise((r) => setTimeout(r, 20))

    expect(cb).not.toHaveBeenCalled()
  })

  it('does not notify subscribers when a watch event fires but the raw file content is unchanged', async () => {
    const { fs, trigger } = fakeFs(validSnapshot)
    const service = createUsageService({ snapshotPath: SNAPSHOT_PATH, fs, debounceMs: 5 })
    const cb = vi.fn()
    service.onChange(cb)

    // Simulates an unrelated write elsewhere in userData (DB, settings JSON) waking the directory
    // watcher even though the snapshot file itself is untouched.
    trigger()
    await new Promise((r) => setTimeout(r, 20))

    expect(cb).not.toHaveBeenCalled()
  })

  it('still notifies once real content follows a no-op watch event', async () => {
    const { fs, setContent, trigger } = fakeFs(validSnapshot)
    const service = createUsageService({ snapshotPath: SNAPSHOT_PATH, fs, debounceMs: 5 })
    const cb = vi.fn()
    service.onChange(cb)

    trigger()
    await new Promise((r) => setTimeout(r, 20))
    expect(cb).not.toHaveBeenCalled()

    setContent(JSON.stringify({ ...JSON.parse(validSnapshot), capturedAt: 1700000000001 }))
    trigger()
    await new Promise((r) => setTimeout(r, 20))

    expect(cb).toHaveBeenCalledTimes(1)
    expect(service.get()?.capturedAt).toBe(1700000000001)
  })

  it('a malformed snapshot at change time tolerates gracefully back to null', async () => {
    const { fs, setContent, trigger } = fakeFs(validSnapshot)
    const service = createUsageService({ snapshotPath: SNAPSHOT_PATH, fs, debounceMs: 5 })
    expect(service.get()).not.toBeNull()

    setContent('not json at all {{{')
    trigger()
    await new Promise((r) => setTimeout(r, 20))

    expect(service.get()).toBeNull()
  })
})

describe('createUsageService: dispose', () => {
  it('closes the directory watcher', () => {
    const { fs, closeWatcher } = fakeFs(null)
    const service = createUsageService({ snapshotPath: SNAPSHOT_PATH, fs })
    service.dispose()
    expect(closeWatcher).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending debounced refresh so it never fires after dispose', async () => {
    const { fs, setContent, trigger } = fakeFs(null)
    const service = createUsageService({ snapshotPath: SNAPSHOT_PATH, fs, debounceMs: 20 })
    const cb = vi.fn()
    service.onChange(cb)

    setContent(validSnapshot)
    trigger()
    service.dispose()
    await new Promise((r) => setTimeout(r, 40))

    expect(cb).not.toHaveBeenCalled()
  })
})
