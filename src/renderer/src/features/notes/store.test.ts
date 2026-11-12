import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { NoteDay, NoteEntry, NoteQuery } from '@common/domain'

vi.mock('./ipc')
vi.mock('@renderer/shared/ui/toast')
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'
import { HISTORY_PAGE_DAYS, SEARCH_DEBOUNCE_MS, useNotesStore } from './store'

const mocked = vi.mocked(api)

const entry = (id: string, day: string, body = `note ${id}`): NoteEntry => ({
  id,
  day,
  body,
  createdAt: 1,
  updatedAt: 1
})

/**
 * A stand-in for the core's list: applies the day bounds, the cursor, the day limit and a plain
 * substring text filter to a fixed set of entries and groups them the way the repo does. Enough to show which rows each of
 * the store's queries can reach.
 */
function serve(entries: NoteEntry[]): void {
  mocked.list.mockImplementation(async (q: NoteQuery) => {
    const words = q.text.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const rows = entries
      .filter((e) => (q.from === null || e.day >= q.from) && (q.to === null || e.day <= q.to))
      .filter((e) => q.before === null || e.day < q.before)
      .filter((e) => words.every((w) => e.body.toLowerCase().includes(w)))
      .sort((a, b) => (a.day === b.day ? 0 : a.day < b.day ? 1 : -1))
    const days: NoteDay[] = []
    for (const e of rows) {
      const last = days[days.length - 1]
      if (last?.day === e.day) last.entries.push({ ...e })
      else days.push({ day: e.day, entries: [{ ...e }] })
    }
    return q.dayLimit === null ? days : days.slice(0, q.dayLimit)
  })
}

/** The history request for one page: the days of a page plus one, to learn whether more follow. */
const historyQuery = (over: Partial<NoteQuery>): NoteQuery => ({
  text: '',
  from: null,
  to: null,
  before: null,
  dayLimit: HISTORY_PAGE_DAYS + 1,
  ...over
})
const todayQuery: NoteQuery = {
  text: '',
  from: '2026-03-02',
  to: null,
  before: null,
  dayLimit: null
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
      historyHasMore: false,
      historyLimit: HISTORY_PAGE_DAYS,
      loadingOlder: false,
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
        todayQuery,
        historyQuery({ to: '2026-03-01' })
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
    expect(queries()).toContainEqual(historyQuery({ to: '2026-03-01' }))

    mocked.list.mockClear()
    useNotesStore.getState().setRange('2026-02-01', '2026-02-15')
    await vi.runOnlyPendingTimersAsync()
    expect(queries()).toContainEqual(historyQuery({ from: '2026-02-01', to: '2026-02-15' }))
    // Today's query ignores the range entirely.
    expect(queries()).toContainEqual(todayQuery)
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
      expect.arrayContaining([historyQuery({ text: 'cache', to: '2026-03-01' })])
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

/** One entry on each of the `count` days before 2026-03-02, newest first by index. */
function pastDays(count: number, body = 'note'): NoteEntry[] {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(2026, 2, 1 - i, 12)
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    return entry(`p${i}`, day, `${body} ${i}`)
  })
}
const historyDays = (): string[] => useNotesStore.getState().history.map((d) => d.day)

describe('paging the history', () => {
  test('45 past days load as the 30 newest, with older days on offer', async () => {
    const stored = pastDays(45)
    serve([entry('t', '2026-03-02'), ...stored])
    await useNotesStore.getState().load()

    expect(historyDays()).toEqual(stored.slice(0, 30).map((e) => e.day))
    expect(useNotesStore.getState().historyHasMore).toBe(true)
    // Today is never paged.
    expect(queries()).toContainEqual(todayQuery)
    expect(todayIds()).toEqual(['t'])
  })

  test('exactly one page of days has nothing older, and one day more does', async () => {
    serve(pastDays(30))
    await useNotesStore.getState().load()
    expect(historyDays()).toHaveLength(30)
    expect(useNotesStore.getState().historyHasMore).toBe(false)

    serve(pastDays(31))
    await useNotesStore.getState().load()
    expect(historyDays()).toHaveLength(30)
    expect(useNotesStore.getState().historyHasMore).toBe(true)
  })

  test('loadOlder appends the days after the last one shown and ends the offer', async () => {
    const stored = pastDays(45)
    serve(stored)
    await useNotesStore.getState().load()
    mocked.list.mockClear()

    await useNotesStore.getState().loadOlder()

    expect(historyDays()).toEqual(stored.map((e) => e.day))
    expect(useNotesStore.getState().historyHasMore).toBe(false)
    expect(useNotesStore.getState().loadingOlder).toBe(false)
    // One request, for the days before the last shown, and none for Today.
    expect(queries()).toEqual([historyQuery({ before: stored[29].day, to: '2026-03-01' })])
  })

  test('older pages follow one another until the history ends', async () => {
    const stored = pastDays(75)
    serve(stored)
    await useNotesStore.getState().load()
    await useNotesStore.getState().loadOlder()
    expect(historyDays()).toHaveLength(60)
    expect(useNotesStore.getState().historyHasMore).toBe(true)
    await useNotesStore.getState().loadOlder()
    expect(historyDays()).toEqual(stored.map((e) => e.day))
    expect(useNotesStore.getState().historyHasMore).toBe(false)
  })

  test('older pages of a search ask under that search and its range', async () => {
    const stored = pastDays(40, 'cache')
    serve([...stored, entry('other', '2026-01-01', 'lunch')])
    useNotesStore.getState().setQuery('cache')
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    expect(historyDays()).toHaveLength(30)
    mocked.list.mockClear()

    await useNotesStore.getState().loadOlder()
    expect(historyDays()).toEqual(stored.map((e) => e.day))
    expect(queries()).toEqual([
      historyQuery({ text: 'cache', before: stored[29].day, to: '2026-03-01' })
    ])
  })

  test('loadOlder does nothing when nothing is older, and two clicks are one request', async () => {
    serve(pastDays(10))
    await useNotesStore.getState().load()
    mocked.list.mockClear()
    await useNotesStore.getState().loadOlder()
    expect(mocked.list).not.toHaveBeenCalled()

    serve(pastDays(45))
    await useNotesStore.getState().load()
    mocked.list.mockClear()
    await Promise.all([useNotesStore.getState().loadOlder(), useNotesStore.getState().loadOlder()])
    expect(mocked.list).toHaveBeenCalledTimes(1)
    expect(historyDays()).toHaveLength(45)
  })

  test('changing the search or a date after older days were loaded starts from the first page', async () => {
    const stored = pastDays(75, 'cache')
    serve(stored)
    await useNotesStore.getState().load()
    await useNotesStore.getState().loadOlder()
    expect(historyDays()).toHaveLength(60)

    // A search that matches every day still shows a first page only.
    useNotesStore.getState().setQuery('cache')
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    expect(historyDays()).toHaveLength(30)
    expect(useNotesStore.getState().historyHasMore).toBe(true)

    await useNotesStore.getState().loadOlder()
    expect(historyDays()).toHaveLength(60)

    useNotesStore.getState().setRange(stored[70].day, null)
    await vi.runOnlyPendingTimersAsync()
    expect(historyDays()).toEqual(stored.slice(0, 30).map((e) => e.day))
    expect(useNotesStore.getState().historyHasMore).toBe(true)

    await useNotesStore.getState().loadOlder()
    expect(historyDays()).toHaveLength(60)
    useNotesStore.getState().setRange(null, null)
    await vi.runOnlyPendingTimersAsync()
    expect(historyDays()).toHaveLength(30)
  })

  test('after a filter change the next older page continues the new result, not the old one', async () => {
    const stored = pastDays(75, 'cache')
    serve(stored)
    await useNotesStore.getState().load()
    await useNotesStore.getState().loadOlder()

    useNotesStore.getState().setRange(null, stored[10].day)
    await vi.runOnlyPendingTimersAsync()
    expect(historyDays()).toEqual(stored.slice(10, 40).map((e) => e.day))
    await useNotesStore.getState().loadOlder()
    expect(historyDays()).toEqual(stored.slice(10, 70).map((e) => e.day))
  })

  test('no older page is read while a changed search is still waiting for its pause', async () => {
    const stored = pastDays(75, 'cache')
    serve(stored)
    await useNotesStore.getState().load()
    expect(historyDays()).toHaveLength(30)
    mocked.list.mockClear()

    // The user types, and clicks "Show older days" before the debounce has fired.
    useNotesStore.getState().setQuery('cache')
    await useNotesStore.getState().loadOlder()
    expect(mocked.list).not.toHaveBeenCalled()
    expect(useNotesStore.getState().historyLimit).toBe(HISTORY_PAGE_DAYS)

    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    expect(historyDays()).toEqual(stored.slice(0, 30).map((e) => e.day))
    expect(useNotesStore.getState().historyHasMore).toBe(true)
    expect(useNotesStore.getState().historyLimit).toBe(HISTORY_PAGE_DAYS)

    // Once the new search has been read, paging works again, under that search.
    await useNotesStore.getState().loadOlder()
    expect(historyDays()).toHaveLength(60)
  })

  test('an older page still on its way is dropped when the filters change', async () => {
    const stored = pastDays(75)
    serve(stored)
    await useNotesStore.getState().load()

    let release: (days: NoteDay[]) => void = () => {}
    mocked.list.mockImplementationOnce(() => new Promise<NoteDay[]>((r) => (release = r)))
    const pending = useNotesStore.getState().loadOlder()
    await vi.advanceTimersByTimeAsync(0)
    expect(useNotesStore.getState().loadingOlder).toBe(true)

    useNotesStore.getState().setRange(null, stored[5].day)
    await vi.runOnlyPendingTimersAsync()
    release([{ day: stored[30].day, entries: [entry('late', stored[30].day)] }])
    await pending

    expect(useNotesStore.getState().loadingOlder).toBe(false)
    expect(historyDays()).toEqual(stored.slice(5, 35).map((e) => e.day))
  })

  test('a failed older page is reported, keeps the list, and can be retried', async () => {
    serve(pastDays(45))
    await useNotesStore.getState().load()
    const failure = new Error('db gone')
    mocked.list.mockRejectedValueOnce(failure)

    await useNotesStore.getState().loadOlder()
    expect(reportError).toHaveBeenCalledWith('Could not load older notes', failure)
    expect(historyDays()).toHaveLength(30)
    expect(useNotesStore.getState().status).toBe('ready')
    expect(useNotesStore.getState().historyHasMore).toBe(true)
    expect(useNotesStore.getState().loadingOlder).toBe(false)

    await useNotesStore.getState().loadOlder()
    expect(historyDays()).toHaveLength(45)
  })

  test('adding, editing and deleting keep the pages already loaded', async () => {
    const stored = [entry('t', '2026-03-02'), ...pastDays(75)]
    serve(stored)
    mocked.add.mockImplementation(async (body) => {
      const e = entry('new', '2026-03-02', body)
      stored.push(e)
      return e
    })
    mocked.update.mockImplementation(async (id, body) => {
      const e = stored.find((x) => x.id === id)!
      e.body = body
      return { ...e }
    })
    mocked.remove.mockImplementation(async (id) => {
      stored.splice(
        stored.findIndex((x) => x.id === id),
        1
      )
    })
    await useNotesStore.getState().load()
    await useNotesStore.getState().loadOlder()
    expect(historyDays()).toHaveLength(60)

    await useNotesStore.getState().add('another')
    expect(historyDays()).toHaveLength(60)
    expect(todayIds()).toEqual(['t', 'new'])
    expect(useNotesStore.getState().historyHasMore).toBe(true)

    await useNotesStore.getState().update('p45', 'edited deep down')
    expect(historyDays()).toHaveLength(60)
    expect(
      useNotesStore.getState().history.find((d) => d.entries[0].id === 'p45')?.entries[0].body
    ).toBe('edited deep down')

    // A deleted entry empties its day; the pages refill from the older days, still 60 shown.
    await useNotesStore.getState().remove('p5')
    expect(historyDays()).toHaveLength(60)
    expect(historyIds()).not.toContain('p5')
    expect(historyIds()).toContain('p60')
    expect(useNotesStore.getState().historyHasMore).toBe(true)
  })

  test('a reload once the end of the history is reached still offers nothing older', async () => {
    serve(pastDays(35))
    await useNotesStore.getState().load()
    await useNotesStore.getState().loadOlder()
    expect(useNotesStore.getState().historyHasMore).toBe(false)
    await useNotesStore.getState().load()
    expect(historyDays()).toHaveLength(35)
    expect(useNotesStore.getState().historyHasMore).toBe(false)
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
