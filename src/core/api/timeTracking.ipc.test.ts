import { describe, expect, test, vi } from 'vitest'
import type { RunningTimer, TimeEntry } from '@common/domain'
import { Channel } from '@common/ipc'
import type { TimeTrackingService } from '../timeTracking/timeTracking'
import { createTimeTrackingHandlers, timeTrackingWireRoutes } from './timeTracking.ipc'

const entry = (over: Partial<TimeEntry> = {}): TimeEntry => ({
  id: 's1',
  source: 'auto',
  day: '2026-07-06',
  description: 'Session s1',
  issueKey: 'FID2507-611',
  durationMs: 60 * 60_000,
  ...over
})

const TIMER: RunningTimer = {
  startedAt: 1_700_000_000_000,
  description: 'Refactor validators',
  issueKey: 'FID2507-611'
}

function makeService(over: Partial<TimeTrackingService> = {}): TimeTrackingService {
  return {
    getWeek: vi.fn(async () => [entry()]),
    refreshWeek: vi.fn(async () => [entry({ id: 's2' })]),
    addManual: vi.fn(() => entry({ id: 'm1', source: 'manual' })),
    updateEntry: vi.fn(async () => entry({ durationMs: 1 })),
    deleteEntry: vi.fn(async () => {}),
    getRunningTimer: vi.fn(() => TIMER),
    startTimer: vi.fn(() => TIMER),
    updateTimer: vi.fn(() => TIMER),
    stopTimer: vi.fn(() => entry({ id: 't1', source: 'manual', durationMs: 25 * 60_000 })),
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
    const update = { description: 'Session s1', issueKey: null, durationMs: 1 }
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
    await expect(
      h.updateEntry('auto', 'nope', { description: 'x', issueKey: null, durationMs: 1 })
    ).rejects.toThrow(/Unknown session: nope/)
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

  test('getTimer returns what the service holds', async () => {
    const h = createTimeTrackingHandlers({ service: makeService() })
    await expect(h.getTimer()).resolves.toEqual(TIMER)
  })

  test('startTimer forwards the description and issue key', async () => {
    const service = makeService()
    const h = createTimeTrackingHandlers({ service })
    await expect(h.startTimer('Refactor validators', 'FID2507-611')).resolves.toEqual(TIMER)
    expect(service.startTimer).toHaveBeenCalledWith('Refactor validators', 'FID2507-611')
  })

  test('updateTimer forwards both fields, including a cleared issue key', async () => {
    const service = makeService()
    const h = createTimeTrackingHandlers({ service })
    await h.updateTimer('Renamed', null)
    expect(service.updateTimer).toHaveBeenCalledWith('Renamed', null)
  })

  test('stopTimer returns the logged entry', async () => {
    const h = createTimeTrackingHandlers({ service: makeService() })
    expect((await h.stopTimer())?.id).toBe('t1')
  })

  test('a refused start crosses the boundary as a message-only Error', async () => {
    const h = createTimeTrackingHandlers({
      service: makeService({
        startTimer: vi.fn(() => {
          throw new Error('A timer is already running')
        })
      })
    })
    await expect(h.startTimer('x', null)).rejects.toThrow(/A timer is already running/)
  })
})

describe('timeTrackingWireRoutes', () => {
  test('binds every request/response channel to the handlers', async () => {
    const h = createTimeTrackingHandlers({ service: makeService() })
    const routes = timeTrackingWireRoutes(h)
    const call = (channel: string, ...args: unknown[]): unknown =>
      (routes[channel] as (...a: unknown[]) => unknown)(...args)

    expect(Object.keys(routes).sort()).toEqual(
      [
        Channel.timeTrackingGetWeek,
        Channel.timeTrackingRefreshWeek,
        Channel.timeTrackingAddManual,
        Channel.timeTrackingUpdateEntry,
        Channel.timeTrackingDeleteEntry,
        Channel.timeTrackingGetTimer,
        Channel.timeTrackingStartTimer,
        Channel.timeTrackingUpdateTimer,
        Channel.timeTrackingStopTimer
      ].sort()
    )

    const week = (await call(Channel.timeTrackingGetWeek, '2026-07-06')) as TimeEntry[]
    expect(week.map((e) => e.id)).toEqual(['s1'])

    const updated = (await call(Channel.timeTrackingUpdateEntry, 'auto', 's1', {
      description: 'Session s1',
      issueKey: null,
      durationMs: 1
    })) as TimeEntry
    expect(updated.durationMs).toBe(1)

    const started = (await call(
      Channel.timeTrackingStartTimer,
      'Refactor validators',
      'FID2507-611'
    )) as RunningTimer
    expect(started).toEqual(TIMER)
  })
})
