import { describe, expect, it, vi } from 'vitest'
import type { ClaudeUsage } from '@common/domain'
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

describe('createUsageSource', () => {
  it('starts from whatever the file already had', () => {
    const { file } = fakeFile(snapshot(1000, 79))
    const source = createUsageSource({ file, fetchLive: async () => null })
    expect(source.get()?.capturedAt).toBe(1000)
  })

  it('adopts the live reading on refresh', async () => {
    const { file } = fakeFile(snapshot(1000, 79))
    const source = createUsageSource({ file, fetchLive: async () => snapshot(2000, 29) })

    expect((await source.refresh())?.fiveHour?.usedPercent).toBe(29)
    expect(source.get()?.fiveHour?.usedPercent).toBe(29)
  })

  it('keeps the snapshot it had when the live query has nothing to offer', async () => {
    const { file } = fakeFile(snapshot(1000, 79))
    const source = createUsageSource({ file, fetchLive: async () => null })

    expect((await source.refresh())?.capturedAt).toBe(1000)
  })

  it('is not undone by a stale file push arriving after a refresh', async () => {
    const { file, push } = fakeFile(snapshot(1000, 79))
    const source = createUsageSource({ file, fetchLive: async () => snapshot(2000, 29) })
    await source.refresh()

    // A statusline capture from before the live reading, pushed late.
    push(snapshot(1500, 79))

    expect(source.get()?.fiveHour?.usedPercent).toBe(29)
  })

  it('adopts a genuinely newer statusline capture over an older live reading', async () => {
    const { file, push } = fakeFile(null)
    const source = createUsageSource({ file, fetchLive: async () => snapshot(2000, 29) })
    await source.refresh()

    push(snapshot(3000, 31))

    expect(source.get()?.fiveHour?.usedPercent).toBe(31)
  })

  it('notifies subscribers only when the freshest snapshot actually changes', async () => {
    const { file, push } = fakeFile(snapshot(1000, 79))
    const source = createUsageSource({ file, fetchLive: async () => snapshot(500, 12) })
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
    const source = createUsageSource({ file, fetchLive: async () => null })

    setSilently(snapshot(1000, 79))

    expect(source.get()?.capturedAt).toBe(1000)
  })

  it('works with no file source at all (statusline tee could not be wired)', async () => {
    const source = createUsageSource({
      file: { get: () => null, onChange: () => () => {} },
      fetchLive: async () => snapshot(2000, 29)
    })
    expect(source.get()).toBeNull()
    expect((await source.refresh())?.fiveHour?.usedPercent).toBe(29)
  })
})
