import { describe, expect, test, vi } from 'vitest'
import type { TimeEntry } from '@common/domain'
import { Channel } from '@common/ipc'
import type { TimeTrackingService } from '../timeTracking/timeTracking'
import { createTimeTrackingHandlers, registerTimeTrackingHandlers } from './timeTracking.ipc'

const entry = (over: Partial<TimeEntry> = {}): TimeEntry => ({
  id: 's1',
  source: 'auto',
  day: '2026-07-06',
  description: 'Session s1',
  issueKey: 'FID2507-611',
  durationMs: 60 * 60_000,
  ...over
})

function makeService(over: Partial<TimeTrackingService> = {}): TimeTrackingService {
  return {
    getWeek: vi.fn(async () => [entry()]),
    refreshWeek: vi.fn(async () => [entry({ id: 's2' })]),
    addManual: vi.fn(() => entry({ id: 'm1', source: 'manual' })),
    updateEntry: vi.fn(async () => entry({ durationMs: 1 })),
    deleteEntry: vi.fn(async () => {}),
    ...over
  }
}

describe('timeTracking handlers', () => {
  test('getWeek delegates with the week start', async () => {
    const service = makeService()
    const h = createTimeTrackingHandlers({ service })
    expect((await h.getWeek('2026-07-06')).map((e) => e.id)).toEqual(['s1'])
    expect(service.getWeek).toHaveBeenCalledWith('2026-07-06')
  })

  test('refreshWeek delegates with the week start', async () => {
    const service = makeService()
    const h = createTimeTrackingHandlers({ service })
    expect((await h.refreshWeek('2026-07-06')).map((e) => e.id)).toEqual(['s2'])
    expect(service.refreshWeek).toHaveBeenCalledWith('2026-07-06')
  })

  test('addManual delegates the input', async () => {
    const service = makeService()
    const h = createTimeTrackingHandlers({ service })
    const input = { day: '2026-07-06', description: 'Meeting', issueKey: null, durationMs: 1 }
    expect((await h.addManual(input)).id).toBe('m1')
    expect(service.addManual).toHaveBeenCalledWith(input)
  })

  test('updateEntry delegates source, id and update', async () => {
    const service = makeService()
    const h = createTimeTrackingHandlers({ service })
    const update = { issueKey: null, durationMs: 1 }
    expect((await h.updateEntry('auto', 's1', update)).durationMs).toBe(1)
    expect(service.updateEntry).toHaveBeenCalledWith('auto', 's1', update)
  })

  test('deleteEntry delegates source and id', async () => {
    const service = makeService()
    const h = createTimeTrackingHandlers({ service })
    await h.deleteEntry('manual', 'm1')
    expect(service.deleteEntry).toHaveBeenCalledWith('manual', 'm1')
  })

  test('wraps a thrown error as a message-only Error', async () => {
    const service = makeService({
      updateEntry: vi.fn(async () => {
        throw new Error('Unknown session: nope')
      })
    })
    const h = createTimeTrackingHandlers({ service })
    await expect(h.updateEntry('auto', 'nope', { issueKey: null, durationMs: 1 })).rejects.toThrow(
      /Unknown session: nope/
    )
  })

  test('wraps a non-Error throw into an Error with a message', async () => {
    const service = makeService({
      getWeek: vi.fn(async () => {
        throw 'boom'
      })
    })
    const h = createTimeTrackingHandlers({ service })
    await expect(h.getWeek('2026-07-06')).rejects.toThrow(/boom/)
  })
})

describe('registerTimeTrackingHandlers', () => {
  test('binds the five request/response channels to the handlers', async () => {
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
        registered.set(channel, listener)
      }
    }
    const h = createTimeTrackingHandlers({ service: makeService() })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTimeTrackingHandlers(ipcMain as any, h)

    expect([...registered.keys()].sort()).toEqual(
      [
        Channel.timeTrackingGetWeek,
        Channel.timeTrackingRefreshWeek,
        Channel.timeTrackingAddManual,
        Channel.timeTrackingUpdateEntry,
        Channel.timeTrackingDeleteEntry
      ].sort()
    )

    const week = (await registered.get(Channel.timeTrackingGetWeek)!({}, '2026-07-06')) as TimeEntry[]
    expect(week.map((e) => e.id)).toEqual(['s1'])

    const updated = (await registered.get(Channel.timeTrackingUpdateEntry)!({}, 'auto', 's1', {
      issueKey: null,
      durationMs: 1
    })) as TimeEntry
    expect(updated.durationMs).toBe(1)
  })
})
