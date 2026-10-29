import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { NoteDay, NoteEntry, NoteQuery } from '@common/domain'
import { addDays, dayKeyOf } from '@common/week'

vi.mock('../ipc')
vi.mock('@renderer/shared/ui/toast')
import * as api from '../ipc'
import { HISTORY_PAGE_DAYS, useNotesStore } from '../store'
import { NotesView } from './NotesView'

const mocked = vi.mocked(api)

const TODAY = dayKeyOf(Date.now())
const YESTERDAY = addDays(TODAY, -1)
const LAST_WEEK = addDays(TODAY, -7)

/** A capture time on the given day, at the given local hour and minute. */
const at = (day: string, h: number, m: number): number => {
  const [y, mo, d] = day.split('-').map(Number)
  return new Date(y, mo - 1, d, h, m).getTime()
}

const entry = (id: string, day: string, body: string, time = at(day, 9, 0)): NoteEntry => ({
  id,
  day,
  body,
  createdAt: time,
  updatedAt: time
})

/**
 * The core's list over a mutable set of entries: day bounds, the cursor and day limit, plus a
 * plain substring search, grouped newest day first. The view only needs to see which rows each query reaches.
 */
let stored: NoteEntry[] = []
function serveStored(): void {
  mocked.list.mockImplementation(async (q: NoteQuery) => {
    const words = q.text.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const days: NoteDay[] = []
    const rows = stored
      .filter((e) => (q.from === null || e.day >= q.from) && (q.to === null || e.day <= q.to))
      .filter((e) => q.before === null || e.day < q.before)
      .filter((e) => words.every((w) => e.body.toLowerCase().includes(w)))
      .sort((a, b) => (a.day === b.day ? 0 : a.day < b.day ? 1 : -1))
    for (const e of rows) {
      const last = days[days.length - 1]
      if (last?.day === e.day) last.entries.push({ ...e })
      else days.push({ day: e.day, entries: [{ ...e }] })
    }
    return q.dayLimit === null ? days : days.slice(0, q.dayLimit)
  })
}

async function mount(): Promise<void> {
  await act(async () => {
    render(<NotesView />)
  })
}

const today = (): HTMLElement => screen.getByRole('region', { name: 'Today' })
const history = (): HTMLElement => screen.getByRole('region', { name: 'History' })
const rowsIn = (el: HTMLElement): HTMLElement[] =>
  [...el.querySelectorAll<HTMLElement>('.ix-note')]
const bodiesIn = (el: HTMLElement): string[] =>
  rowsIn(el).map((row) => row.querySelector('.ix-note__body')?.textContent ?? '')
const rowOf = (body: string): HTMLElement =>
  rowsIn(document.body).find((row) => row.querySelector('.ix-note__body')?.textContent === body)!
const captureBox = (): HTMLTextAreaElement => screen.getByLabelText('New note')

beforeEach(() => {
  vi.clearAllMocks()
  stored = []
  serveStored()
  useNotesStore.setState({
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
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Today', () => {
  test('shows the entries in capture order with their times, and settles without a render loop', async () => {
    stored = [
      entry('a', TODAY, 'first thought', at(TODAY, 9, 5)),
      entry('b', TODAY, 'second thought', at(TODAY, 14, 30))
    ]
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    })
    try {
      await mount()
      expect(bodiesIn(today())).toEqual(['first thought', 'second thought'])
      expect(rowsIn(today()).map((r) => r.querySelector('.ix-note__time')?.textContent)).toEqual([
        '09:05',
        '14:30'
      ])
      expect(logged).toEqual([])
    } finally {
      consoleError.mockRestore()
    }
  })

  test('a view left open across midnight moves the day into the history by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    vi.setSystemTime(new Date(2026, 2, 2, 23, 59, 30))
    stored = [entry('a', '2026-03-02', 'written before midnight')]
    await mount()
    expect(bodiesIn(today())).toEqual(['written before midnight'])

    // Nothing but the clock moves: no click, no reopen.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
    })

    expect(bodiesIn(today())).toEqual([])
    expect(bodiesIn(history())).toEqual(['written before midnight'])
  })

  test('the capture box has the cursor when Notes opens', async () => {
    await mount()
    expect(document.activeElement).toBe(captureBox())
  })
})

describe('the capture box', () => {
  beforeEach(() => {
    mocked.add.mockImplementation(async (body) => {
      const e = entry(`n${stored.length}`, TODAY, body.trim())
      stored.push(e)
      return e
    })
  })

  test('Cmd+Enter adds the text with its line breaks and empties the box', async () => {
    await mount()
    fireEvent.change(captureBox(), { target: { value: 'line one\nline two' } })
    await act(async () => {
      fireEvent.keyDown(captureBox(), { key: 'Enter', metaKey: true })
    })
    expect(mocked.add).toHaveBeenCalledWith('line one\nline two')
    expect(captureBox().value).toBe('')
    expect(bodiesIn(today())).toEqual(['line one\nline two'])
  })

  test('the Add button adds too', async () => {
    await mount()
    fireEvent.change(captureBox(), { target: { value: 'by button' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    })
    expect(mocked.add).toHaveBeenCalledWith('by button')
  })

  test('plain Enter is a new line, not an add', async () => {
    await mount()
    fireEvent.change(captureBox(), { target: { value: 'x' } })
    fireEvent.keyDown(captureBox(), { key: 'Enter' })
    expect(mocked.add).not.toHaveBeenCalled()
  })

  test('whitespace alone adds nothing', async () => {
    await mount()
    fireEvent.change(captureBox(), { target: { value: '  \n\t ' } })
    await act(async () => {
      fireEvent.keyDown(captureBox(), { key: 'Enter', metaKey: true })
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    })
    expect(mocked.add).not.toHaveBeenCalled()
  })

  test('the text stays in the box when saving fails', async () => {
    mocked.add.mockRejectedValue(new Error('locked'))
    await mount()
    fireEvent.change(captureBox(), { target: { value: 'do not lose me' } })
    await act(async () => {
      fireEvent.keyDown(captureBox(), { key: 'Enter', metaKey: true })
    })
    expect(mocked.add).toHaveBeenCalled()
    expect(captureBox().value).toBe('do not lose me')
  })
})

describe('editing an entry', () => {
  beforeEach(() => {
    stored = [entry('a', TODAY, 'original'), entry('h', YESTERDAY, 'from yesterday')]
    mocked.update.mockImplementation(async (id, body) => {
      const e = stored.find((s) => s.id === id)!
      e.body = body
      return { ...e }
    })
  })

  const editor = (): HTMLTextAreaElement => screen.getByLabelText('Edit note')

  test('a double-click opens the editor and Enter saves', async () => {
    await mount()
    fireEvent.doubleClick(rowOf('original').querySelector('.ix-note__body')!)
    expect(document.activeElement).toBe(editor())
    fireEvent.change(editor(), { target: { value: 'edited' } })
    await act(async () => {
      fireEvent.keyDown(editor(), { key: 'Enter' })
    })
    expect(mocked.update).toHaveBeenCalledTimes(1)
    expect(mocked.update).toHaveBeenCalledWith('a', 'edited')
    expect(screen.queryByLabelText('Edit note')).toBeNull()
    expect(bodiesIn(today())).toEqual(['edited'])
  })

  test('the pencil opens the editor and leaving it saves', async () => {
    await mount()
    fireEvent.click(within(rowOf('from yesterday')).getByTitle('Edit'))
    fireEvent.change(editor(), { target: { value: 'changed later' } })
    await act(async () => {
      fireEvent.blur(editor())
    })
    expect(mocked.update).toHaveBeenCalledWith('h', 'changed later')
    expect(bodiesIn(history())).toEqual(['changed later'])
  })

  test('Shift+Enter does not save', async () => {
    await mount()
    fireEvent.doubleClick(rowOf('original'))
    fireEvent.change(editor(), { target: { value: 'two\nlines' } })
    fireEvent.keyDown(editor(), { key: 'Enter', shiftKey: true })
    expect(mocked.update).not.toHaveBeenCalled()
    expect(editor().value).toBe('two\nlines')
  })

  test('Escape cancels and goes no further', async () => {
    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    try {
      await mount()
      fireEvent.doubleClick(rowOf('original'))
      fireEvent.change(editor(), { target: { value: 'thrown away' } })
      fireEvent.keyDown(editor(), { key: 'Escape' })
      expect(screen.queryByLabelText('Edit note')).toBeNull()
      expect(mocked.update).not.toHaveBeenCalled()
      expect(bodiesIn(today())).toEqual(['original'])
      expect(outer).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', outer)
    }
  })

  test('saving an empty text keeps the old one', async () => {
    await mount()
    fireEvent.doubleClick(rowOf('original'))
    fireEvent.change(editor(), { target: { value: '   ' } })
    await act(async () => {
      fireEvent.keyDown(editor(), { key: 'Enter' })
    })
    expect(mocked.update).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Edit note')).toBeNull()
    expect(bodiesIn(today())).toEqual(['original'])
  })

  test('a failed save keeps the editor open with the draft', async () => {
    mocked.update.mockRejectedValue(new Error('locked'))
    await mount()
    fireEvent.doubleClick(rowOf('original'))
    fireEvent.change(editor(), { target: { value: 'keep this draft' } })
    await act(async () => {
      fireEvent.keyDown(editor(), { key: 'Enter' })
    })
    expect(mocked.update).toHaveBeenCalled()
    expect(editor().value).toBe('keep this draft')
  })

  test('delete removes the entry without asking', async () => {
    mocked.remove.mockImplementation(async (id) => {
      stored = stored.filter((s) => s.id !== id)
    })
    await mount()
    await act(async () => {
      fireEvent.click(within(rowOf('original')).getByTitle('Delete'))
    })
    expect(mocked.remove).toHaveBeenCalledWith('a')
    expect(bodiesIn(today())).toEqual([])
  })
})

describe('history', () => {
  test('past days newest first, with no empty days', async () => {
    stored = [
      entry('w', LAST_WEEK, 'last week'),
      entry('t', TODAY, 'today'),
      entry('y1', YESTERDAY, 'yesterday one'),
      entry('y2', YESTERDAY, 'yesterday two')
    ]
    await mount()
    const days = [...history().querySelectorAll<HTMLElement>('.ix-notes__day')]
    expect(days.map((d) => d.dataset.day)).toEqual([YESTERDAY, LAST_WEEK])
    expect(bodiesIn(days[0])).toEqual(['yesterday one', 'yesterday two'])
    expect(bodiesIn(today())).toEqual(['today'])
  })

  test('search narrows the history, leaves Today whole, and marks the matches', async () => {
    stored = [
      entry('t1', TODAY, 'the cache today'),
      entry('t2', TODAY, 'lunch today'),
      entry('y1', YESTERDAY, 'cache yesterday'),
      entry('y2', YESTERDAY, 'lunch yesterday'),
      entry('w', LAST_WEEK, 'lunch last week')
    ]
    await mount()
    fireEvent.change(screen.getByLabelText('Search notes'), { target: { value: 'cach' } })

    await waitFor(() => expect(bodiesIn(history())).toEqual(['cache yesterday']))
    expect(bodiesIn(today())).toEqual(['the cache today', 'lunch today'])
    expect([...document.querySelectorAll('.ix-notes__hit')].map((m) => m.textContent)).toEqual([
      'cach',
      'cach'
    ])
  })
})

describe('status lines', () => {
  test('no notes at all says so, and the capture box is still there', async () => {
    await mount()
    expect(document.querySelector('.ix-notes__empty')).not.toBeNull()
    expect(document.querySelector('.ix-notes__no-match')).toBeNull()
    expect(captureBox()).toBeTruthy()
  })

  test('a search that hides every past day says no notes match, not that there are none', async () => {
    stored = [entry('y', YESTERDAY, 'cache')]
    await mount()
    fireEvent.change(screen.getByLabelText('Search notes'), { target: { value: 'zzz' } })
    await waitFor(() => expect(document.querySelector('.ix-notes__no-match')).not.toBeNull())
    expect(document.querySelector('.ix-notes__empty')).toBeNull()
  })

  test('a date range that hides every past day says no notes match', async () => {
    stored = [entry('w', LAST_WEEK, 'old')]
    await mount()
    await act(async () => {
      fireEvent.change(history().querySelector('.ix-notes__from')!, {
        target: { value: YESTERDAY }
      })
    })
    expect(useNotesStore.getState().from).toBe(YESTERDAY)
    expect(document.querySelector('.ix-notes__no-match')).not.toBeNull()
    expect(document.querySelector('.ix-notes__empty')).toBeNull()
  })

  test('a failed load shows the error and never looks like an empty list', async () => {
    mocked.list.mockRejectedValue(new Error('db gone'))
    await mount()
    expect(document.querySelector('.ix-notes__error')?.textContent).toContain('db gone')
    expect(document.querySelector('.ix-notes__empty')).toBeNull()
    expect(document.querySelector('.ix-notes__no-match')).toBeNull()
  })
})

describe('older days', () => {
  const olderButton = (): HTMLElement | null => screen.queryByRole('button', { name: 'Show older days' })
  const shownDays = (): string[] =>
    [...history().querySelectorAll<HTMLElement>('.ix-notes__day')].map((d) => d.dataset.day!)

  /** One entry per day on the `count` days before today, newest first by index. */
  const pastDays = (count: number, body = 'note'): NoteEntry[] =>
    Array.from({ length: count }, (_, i) => {
      const day = addDays(YESTERDAY, -i)
      return entry(`p${i}`, day, `${body} ${i}`)
    })

  test('45 past days show the 30 newest and a button that brings in the rest and goes away', async () => {
    stored = pastDays(45)
    await mount()
    expect(shownDays()).toEqual(stored.slice(0, 30).map((e) => e.day))
    expect(olderButton()).not.toBeNull()

    await act(async () => {
      fireEvent.click(olderButton()!)
    })
    expect(shownDays()).toEqual(stored.map((e) => e.day))
    expect(olderButton()).toBeNull()
  })

  test('30 or fewer past days offer no button', async () => {
    stored = pastDays(30)
    await mount()
    expect(shownDays()).toHaveLength(30)
    expect(olderButton()).toBeNull()
  })

  test('a search matching 40 days shows 30 and the button, then the other 10, with matches marked', async () => {
    stored = [...pastDays(40, 'cache'), entry('x', YESTERDAY, 'lunch')]
    await mount()
    fireEvent.change(screen.getByLabelText('Search notes'), { target: { value: 'cach' } })
    // The unmatched newest day is on screen until the search has answered.
    await waitFor(() => expect(screen.queryByText('lunch')).toBeNull())
    expect(shownDays()).toHaveLength(30)
    expect(olderButton()).not.toBeNull()

    await act(async () => {
      fireEvent.click(olderButton()!)
    })
    expect(shownDays()).toHaveLength(40)
    expect(olderButton()).toBeNull()
    expect(document.querySelectorAll('.ix-notes__hit')).toHaveLength(40)
  })

  test('changing the search text or a date after loading older days shows the first page again', async () => {
    stored = pastDays(75, 'cache')
    await mount()
    await act(async () => {
      fireEvent.click(olderButton()!)
    })
    expect(shownDays()).toHaveLength(60)

    fireEvent.change(screen.getByLabelText('Search notes'), { target: { value: 'cache' } })
    await waitFor(() => expect(shownDays()).toHaveLength(30))
    expect(olderButton()).not.toBeNull()

    await act(async () => {
      fireEvent.click(olderButton()!)
    })
    expect(shownDays()).toHaveLength(60)
    await act(async () => {
      fireEvent.change(history().querySelector('.ix-notes__from')!, {
        target: { value: stored[70].day }
      })
    })
    expect(shownDays()).toEqual(stored.slice(0, 30).map((e) => e.day))
  })

  test('adding an entry keeps the older days that were loaded', async () => {
    stored = pastDays(45)
    mocked.add.mockImplementation(async (body) => {
      const e = entry('new', TODAY, body)
      stored.push(e)
      return e
    })
    await mount()
    await act(async () => {
      fireEvent.click(olderButton()!)
    })
    expect(shownDays()).toHaveLength(45)

    fireEvent.change(captureBox(), { target: { value: 'written now' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    })
    expect(bodiesIn(today())).toEqual(['written now'])
    expect(shownDays()).toHaveLength(45)
  })

  test('with 10,000 entries over 3,000 days, opening Notes renders at most 30 history days', async () => {
    stored = Array.from({ length: 10_000 }, (_, i) =>
      entry(`s${i}`, addDays(YESTERDAY, -(i % 3_000)), `entry ${i}`)
    )
    await mount()
    expect(shownDays()).toHaveLength(30)
    expect(history().querySelectorAll('.ix-note').length).toBeLessThanOrEqual(30 * 4)
    expect(olderButton()).not.toBeNull()
    fireEvent.change(screen.getByLabelText('Search notes'), { target: { value: 'entry' } })
    await waitFor(() => expect(mocked.list).toHaveBeenCalledWith(expect.objectContaining({ text: 'entry' })))
    await waitFor(() => expect(shownDays()).toHaveLength(30))
  })
})
