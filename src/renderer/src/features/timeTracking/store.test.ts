import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { TimeEntry } from '@common/domain'
import { addDays, weekStartOf } from '@common/week'

vi.mock('./ipc')
vi.mock('@renderer/shared/ui/toast')
import * as api from './ipc'
import { useTimeTrackingStore } from './store'

const mocked = vi.mocked(api)

const CURRENT_WEEK = weekStartOf(Date.now())

const entry = (id: string, over: Partial<TimeEntry> = {}): TimeEntry => ({
  id,
  source: 'auto',
  day: CURRENT_WEEK,
  description: `Entry ${id}`,
  issueKey: null,
  durationMs: 60_000,
  ...over
})

const reset = (): void => {
  useTimeTrackingStore.setState(
    {
      status: 'idle',
      error: null,
      weekStart: CURRENT_WEEK,
      entries: []
    },
    false
  )
}

beforeEach(() => {
  reset()
  vi.clearAllMocks()
})

describe('hydrate', () => {
  test('loads the current week and is ready', async () => {
    mocked.getWeek.mockResolvedValue([entry('a')])
    await useTimeTrackingStore.getState().hydrate()
    const s = useTimeTrackingStore.getState()
    expect(s.status).toBe('ready')
    expect(s.entries.map((e) => e.id)).toEqual(['a'])
    expect(mocked.getWeek).toHaveBeenCalledWith(CURRENT_WEEK)
  })

  test('is a no-op when already loaded', async () => {
    useTimeTrackingStore.setState({ status: 'ready' })
    await useTimeTrackingStore.getState().hydrate()
    expect(mocked.getWeek).not.toHaveBeenCalled()
  })

  test('sets error status when the IPC call fails', async () => {
    mocked.getWeek.mockRejectedValue(new Error('db gone'))
    await useTimeTrackingStore.getState().hydrate()
    expect(useTimeTrackingStore.getState().status).toBe('error')
    expect(useTimeTrackingStore.getState().error).toMatch(/db gone/)
  })
})

describe('week navigation', () => {
  test('prevWeek moves the shown week back by seven days and loads it', async () => {
    mocked.getWeek.mockResolvedValue([])
    await useTimeTrackingStore.getState().prevWeek()
    const expected = addDays(CURRENT_WEEK, -7)
    expect(useTimeTrackingStore.getState().weekStart).toBe(expected)
    expect(mocked.getWeek).toHaveBeenCalledWith(expected)
  })

  test('nextWeek moves forward by seven days', async () => {
    mocked.getWeek.mockResolvedValue([])
    await useTimeTrackingStore.getState().nextWeek()
    expect(useTimeTrackingStore.getState().weekStart).toBe(addDays(CURRENT_WEEK, 7))
  })

  test('goToday returns to the current week', async () => {
    mocked.getWeek.mockResolvedValue([])
    await useTimeTrackingStore.getState().prevWeek()
    await useTimeTrackingStore.getState().goToday()
    expect(useTimeTrackingStore.getState().weekStart).toBe(CURRENT_WEEK)
  })

  test('loadWeek clears stale entries while loading', async () => {
    useTimeTrackingStore.setState({ entries: [entry('stale')], status: 'ready' })
    let resolve!: (v: TimeEntry[]) => void
    mocked.getWeek.mockReturnValue(new Promise((r) => (resolve = r)))
    const loading = useTimeTrackingStore.getState().loadWeek(addDays(CURRENT_WEEK, -7))
    expect(useTimeTrackingStore.getState().entries).toEqual([])
    expect(useTimeTrackingStore.getState().status).toBe('loading')
    resolve([entry('fresh')])
    await loading
    expect(useTimeTrackingStore.getState().entries.map((e) => e.id)).toEqual(['fresh'])
  })

  test('a stale response for a week no longer shown is dropped', async () => {
    let resolveFirst!: (v: TimeEntry[]) => void
    mocked.getWeek
      .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce([entry('second')])
    const first = useTimeTrackingStore.getState().loadWeek(addDays(CURRENT_WEEK, -7))
    const second = useTimeTrackingStore.getState().loadWeek(addDays(CURRENT_WEEK, -14))
    resolveFirst([entry('first')])
    await Promise.all([first, second])
    expect(useTimeTrackingStore.getState().entries.map((e) => e.id)).toEqual(['second'])
  })
})

describe('refresh', () => {
  test('re-scans and replaces the entries', async () => {
    useTimeTrackingStore.setState({ status: 'ready', entries: [entry('old')] })
    mocked.refreshWeek.mockResolvedValue([entry('fresh')])
    await useTimeTrackingStore.getState().refresh()
    const s = useTimeTrackingStore.getState()
    expect(s.status).toBe('ready')
    expect(s.entries.map((e) => e.id)).toEqual(['fresh'])
    expect(mocked.refreshWeek).toHaveBeenCalledWith(CURRENT_WEEK)
  })

  test('a failed refresh keeps existing entries and stays ready', async () => {
    useTimeTrackingStore.setState({ status: 'ready', entries: [entry('kept')] })
    mocked.refreshWeek.mockRejectedValue(new Error('scan failed'))
    await useTimeTrackingStore.getState().refresh()
    const s = useTimeTrackingStore.getState()
    expect(s.status).toBe('ready')
    expect(s.entries.map((e) => e.id)).toEqual(['kept'])
  })
})

describe('mutations reload the shown week', () => {
  test('addManual creates then reloads', async () => {
    const created = entry('m1', { source: 'manual' })
    mocked.addManual.mockResolvedValue(created)
    mocked.getWeek.mockResolvedValue([created])
    await useTimeTrackingStore.getState().addManual({
      day: CURRENT_WEEK,
      description: 'Meeting',
      issueKey: null,
      durationMs: 30 * 60_000
    })
    expect(mocked.addManual).toHaveBeenCalledOnce()
    expect(useTimeTrackingStore.getState().entries.map((e) => e.id)).toEqual(['m1'])
  })

  test('updateEntry sends the entry\'s source and id then reloads', async () => {
    const e = entry('s1')
    mocked.updateEntry.mockResolvedValue({ ...e, durationMs: 1 })
    mocked.getWeek.mockResolvedValue([{ ...e, durationMs: 1 }])
    await useTimeTrackingStore.getState().updateEntry(e, { issueKey: 'AB-1', durationMs: 1 })
    expect(mocked.updateEntry).toHaveBeenCalledWith('auto', 's1', { issueKey: 'AB-1', durationMs: 1 })
    expect(useTimeTrackingStore.getState().entries[0].durationMs).toBe(1)
  })

  test('removeEntry deletes then reloads', async () => {
    const e = entry('m1', { source: 'manual' })
    useTimeTrackingStore.setState({ status: 'ready', entries: [e] })
    mocked.deleteEntry.mockResolvedValue(undefined)
    mocked.getWeek.mockResolvedValue([])
    await useTimeTrackingStore.getState().removeEntry(e)
    expect(mocked.deleteEntry).toHaveBeenCalledWith('manual', 'm1')
    expect(useTimeTrackingStore.getState().entries).toEqual([])
  })

  test('a failed mutation still reloads so the board resyncs', async () => {
    const e = entry('s1')
    mocked.updateEntry.mockRejectedValue(new Error('nope'))
    mocked.getWeek.mockResolvedValue([e])
    await useTimeTrackingStore.getState().updateEntry(e, { issueKey: null, durationMs: 1 })
    expect(useTimeTrackingStore.getState().entries.map((x) => x.id)).toEqual(['s1'])
    expect(useTimeTrackingStore.getState().status).toBe('ready')
  })
})
