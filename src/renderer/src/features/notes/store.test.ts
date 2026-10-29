import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { NoteDay, NoteEntry, NoteQuery } from '@common/domain'

vi.mock('./ipc')
vi.mock('@renderer/shared/ui/toast')
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'
import { SEARCH_DEBOUNCE_MS, useNotesStore } from './store'

const mocked = vi.mocked(api)

const entry = (id: string, day: string, body = `note ${id}`): NoteEntry => ({
  id,
  day,
  body,
  createdAt: 1,
  updatedAt: 1
})

/**
 * A stand-in for the core's list: applies the day bounds and a plain substring text filter to a
 * fixed set of entries and groups them the way the repo does. Enough to show which rows each of
 * the store's queries can reach.
 */
function serve(entries: NoteEntry[]): void {
  mocked.list.mockImplementation(async (q: NoteQuery) => {
    const words = q.text.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const rows = entries
      .filter((e) => (q.from === null || e.day >= q.from) && (q.to === null || e.day <= q.to))
      .filter((e) => words.every((w) => e.body.toLowerCase().includes(w)))
      .sort((a, b) => (a.day === b.day ? 0 : a.day < b.day ? 1 : -1))
    const days: NoteDay[] = []
    for (const e of rows) {
      const last = days[days.length - 1]
      if (last?.day === e.day) last.entries.push({ ...e })
      else days.push({ day: e.day, entries: [{ ...e }] })
    }
    return days
  })
}

const queries = (): NoteQuery[] => mocked.list.mock.calls.map(([q]) => q)
const todayIds = (): string[] => useNotesStore.getState().todayEntries.map((e) => e.id)
const historyIds = (): string[] =>
  useNotesStore.getState().history.flatMap((d) => d.entries.map((e) => e.id))

const reset = (): void => {
  useNotesStore.setState(
    {
      status: 'idle',
      error: null,
      today: '',
      todayEntries: [],
      history: [],
      historyFiltered: false,
      query: '',
      from: null,
      to: null
    },
    false
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 2, 2, 10, 0))
  reset()
  vi.clearAllMocks()
  serve([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('load', () => {
  test("splits the entries into today's note and the history before it", async () => {
    serve([entry('t1', '2026-03-02'), entry('t2', '2026-03-02'), entry('h1', '2026-03-01')])
    await useNotesStore.getState().load()

    const s = useNotesStore.getState()
    expect(s.status).toBe('ready')
    expect(s.today).toBe('2026-03-02')
    expect(todayIds()).toEqual(['t1', 't2'])
    expect(historyIds()).toEqual(['h1'])
    expect(queries()).toEqual(
      expect.arrayContaining([
        { text: '', from: '2026-03-02', to: null },
        { text: '', from: null, to: '2026-03-01' }
      ])
    )
  })

  test('an entry dated after today (the clock moved back) shows under Today instead of vanishing', async () => {
    serve([
      entry('later', '2026-03-05'),
      entry('now', '2026-03-02'),
      entry('past', '2026-02-20')
    ])
    await useNotesStore.getState().load()
    expect(todayIds()).toEqual(['later', 'now'])
    expect(historyIds()).toEqual(['past'])
  })

  test('a failure is an error, never an empty list', async () => {
    mocked.list.mockRejectedValue(new Error('db gone'))
    await useNotesStore.getState().load()
    expect(useNotesStore.getState().status).toBe('error')
    expect(useNotesStore.getState().error).toBe('db gone')
  })

  test('a later load recovers from a previous error', async () => {
    mocked.list.mockRejectedValueOnce(new Error('db gone'))
    await useNotesStore.getState().load()
    serve([entry('a', '2026-03-02')])
    await useNotesStore.getState().load()
    expect(useNotesStore.getState().status).toBe('ready')
    expect(useNotesStore.getState().error).toBeNull()
    expect(todayIds()).toEqual(['a'])
  })

  test('after midnight the next load moves yesterday into the history', async () => {
    vi.setSystemTime(new Date(2026, 2, 2, 23, 59))
    serve([entry('a', '2026-03-02')])
    await useNotesStore.getState().load()
    expect(todayIds()).toEqual(['a'])

    vi.setSystemTime(new Date(2026, 2, 3, 0, 1))
    await useNotesStore.getState().load()
    expect(useNotesStore.getState().today).toBe('2026-03-03')
    expect(todayIds()).toEqual([])
    expect(historyIds()).toEqual(['a'])
  })
})

describe('filters', () => {
  const corpus = [
    entry('t-cache', '2026-03-02', 'cache today'),
    entry('t-lunch', '2026-03-02', 'lunch today'),
    entry('h-cache', '2026-03-01', 'cache yesterday'),
    entry('h-lunch', '2026-02-20', 'lunch long ago')
  ]

  test('search and dates filter the history and never Today', async () => {
    serve(corpus)
    useNotesStore.getState().setQuery('cache')
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    expect(todayIds()).toEqual(['t-cache', 't-lunch'])
    expect(historyIds()).toEqual(['h-cache'])

    useNotesStore.getState().setRange('2026-03-02', null)
    await vi.runOnlyPendingTimersAsync()
    expect(todayIds()).toEqual(['t-cache', 't-lunch'])
    expect(historyIds()).toEqual([])
  })

  test('the history query never reaches today or later, whatever "to" says', async () => {
    useNotesStore.getState().setRange(null, '2026-03-10')
    await vi.runOnlyPendingTimersAsync()
    expect(queries()).toContainEqual({ text: '', from: null, to: '2026-03-01' })

    mocked.list.mockClear()
    useNotesStore.getState().setRange('2026-02-01', '2026-02-15')
    await vi.runOnlyPendingTimersAsync()
    expect(queries()).toContainEqual({ text: '', from: '2026-02-01', to: '2026-02-15' })
    // Today's query ignores the range entirely.
    expect(queries()).toContainEqual({ text: '', from: '2026-03-02', to: null })
  })

  test('typing is debounced into one search with the latest text', async () => {
    useNotesStore.getState().setQuery('c')
    useNotesStore.getState().setQuery('ca')
    useNotesStore.getState().setQuery('cache')
    // The box shows what was typed straight away.
    expect(useNotesStore.getState().query).toBe('cache')
    expect(mocked.list).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    expect(queries()).toEqual(
      expect.arrayContaining([{ text: 'cache', from: null, to: '2026-03-01' }])
    )
    expect(queries().filter((q) => q.text !== '')).toHaveLength(1)
  })

  test('a slow answer to an older search never replaces a newer one', async () => {
    let releaseOld: (days: NoteDay[]) => void = () => {}
    mocked.list.mockImplementation((q: NoteQuery) => {
      if (q.text === 'old') return new Promise<NoteDay[]>((resolve) => (releaseOld = resolve))
      if (q.text === 'new')
        return Promise.resolve([{ day: '2026-03-01', entries: [entry('new', '2026-03-01')] }])
      return Promise.resolve([])
    })

    useNotesStore.getState().setQuery('old')
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    useNotesStore.getState().setQuery('new')
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    expect(historyIds()).toEqual(['new'])

    releaseOld([{ day: '2026-03-01', entries: [entry('old', '2026-03-01')] }])
    await vi.runOnlyPendingTimersAsync()
    expect(historyIds()).toEqual(['new'])
  })

  test('the history says whether it was filtered, so no match and no notes stay apart', async () => {
    serve(corpus)
    await useNotesStore.getState().load()
    expect(useNotesStore.getState().historyFiltered).toBe(false)

    useNotesStore.getState().setQuery('zzz')
    // Until the search has answered, the history on screen is still the unfiltered one.
    expect(useNotesStore.getState().historyFiltered).toBe(false)
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    expect(useNotesStore.getState().historyFiltered).toBe(true)

    // Punctuation alone has no words to search for.
    useNotesStore.getState().setQuery(' "* ')
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    expect(useNotesStore.getState().historyFiltered).toBe(false)

    useNotesStore.getState().setRange(null, '2026-02-25')
    await vi.runOnlyPendingTimersAsync()
    expect(useNotesStore.getState().historyFiltered).toBe(true)
  })
})

describe('mutations', () => {
  test('add writes the entry, reloads, and answers true', async () => {
    const stored: NoteEntry[] = []
    serve(stored)
    mocked.add.mockImplementation(async (body) => {
      const e = entry('n1', '2026-03-02', body)
      stored.push(e)
      return e
    })
    expect(await useNotesStore.getState().add('first\nsecond')).toBe(true)
    expect(mocked.add).toHaveBeenCalledWith('first\nsecond')
    expect(useNotesStore.getState().todayEntries.map((e) => e.body)).toEqual(['first\nsecond'])
  })

  test('a failed add is reported and answers false', async () => {
    const failure = new Error('database is locked')
    mocked.add.mockRejectedValue(failure)
    expect(await useNotesStore.getState().add('x')).toBe(false)
    expect(reportError).toHaveBeenCalledWith('Could not save the note', failure)
  })

  test('update answers whether it saved, and a failure is reported', async () => {
    mocked.update.mockResolvedValue(entry('a', '2026-03-02', 'b'))
    expect(await useNotesStore.getState().update('a', 'b')).toBe(true)
    expect(mocked.update).toHaveBeenCalledWith('a', 'b')

    const failure = new Error('gone')
    mocked.update.mockRejectedValue(failure)
    expect(await useNotesStore.getState().update('a', 'c')).toBe(false)
    expect(reportError).toHaveBeenCalledWith('Could not save the note', failure)
  })

  test('remove deletes and reloads, and a failure is reported', async () => {
    const stored = [entry('a', '2026-03-02')]
    serve(stored)
    await useNotesStore.getState().load()
    mocked.remove.mockImplementation(async () => {
      stored.length = 0
    })
    await useNotesStore.getState().remove('a')
    expect(mocked.remove).toHaveBeenCalledWith('a')
    expect(todayIds()).toEqual([])

    const failure = new Error('locked')
    mocked.remove.mockRejectedValue(failure)
    await useNotesStore.getState().remove('a')
    expect(reportError).toHaveBeenCalledWith('Could not delete the note', failure)
  })
})
