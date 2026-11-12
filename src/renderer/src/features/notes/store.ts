import type { NoteDay, NoteEntry } from '@common/domain'
import { debounce } from '@common/debounce'
import { noteSearchTerms } from '@common/noteSearch'
import { addDays, dayKeyOf } from '@common/week'
import { createStore } from '@renderer/shared/store/createStore'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'

type Status = 'idle' | 'loading' | 'ready' | 'error'

/** How long typing in the search box waits for a pause before it asks the core again. */
export const SEARCH_DEBOUNCE_MS = 200

/** How many days of history show at first, and how many more each "Show older days" adds. */
export const HISTORY_PAGE_DAYS = 30

interface NotesState {
  status: Status
  error: string | null
  /** The local day key "today" meant at the last load. */
  today: string
  /**
   * Today's note, unfiltered: every entry dated today or later. "Or later" catches an entry whose
   * day a clock or time zone change has put ahead of today, which would otherwise be in neither
   * Today nor the history.
   */
  todayEntries: NoteEntry[]
  /** Past days under the current filters, newest first. Never contains today or a later day. */
  history: NoteDay[]
  /**
   * Whether `history` was loaded under a filter. Kept with the history rather than derived from
   * the inputs, so the empty line and the no-match line describe the list on screen and never the
   * search that has not answered yet.
   */
  historyFiltered: boolean
  /** Whether the history under the current filters has days older than the last one shown. */
  historyHasMore: boolean
  /** How many days of history a reload asks for: the pages loaded so far, 30 days each. */
  historyLimit: number
  /** Whether the next page of older days is being read. */
  loadingOlder: boolean
  /** The search box text, exactly as typed. */
  query: string
  /** Inclusive day bounds of the history, each null for an open end. */
  from: string | null
  to: string | null
  load(): Promise<void>
  /** Change the search text; the history reloads once typing pauses. */
  setQuery(text: string): void
  /** Change the date range; the history reloads straight away. */
  setRange(from: string | null, to: string | null): void
  /** Append the next page of older days to the history, under the filters it was loaded with. */
  loadOlder(): Promise<void>
  /**
   * Add an entry to today's note, answering whether it was really written. A failure has already
   * been reported to the user, wherever they are.
   */
  add(body: string): Promise<boolean>
  /** Replace an entry's body, answering whether it was saved. */
  update(id: string, body: string): Promise<boolean>
  remove(id: string): Promise<void>
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const useNotesStore = createStore<NotesState>()((set, get) => {
  let revision = 0
  /** The reload now running, if any: what is on screen is only settled once it has answered. */
  let reloading: Promise<void> | null = null
  /**
   * The filters the history on screen was read under: the search and range as the user set them,
   * and the upper bound actually sent, which never reaches today.
   */
  let loaded: { text: string; from: string | null; to: string | null; historyTo: string | null } = {
    text: '',
    from: null,
    to: null,
    historyTo: null
  }

  /**
   * Read Today and the history again. Today is `day >= today` and the history `day < today`, so
   * together they reach every entry there is. The history comes back as one request for all the
   * pages loaded so far, so a change to an entry keeps them. Only the newest request may write its
   * answer. It asks for one day more than the pages hold, so the answer itself says whether older
   * days exist; the extra day is never shown.
   */
  function reload(): Promise<void> {
    const mine = ++revision
    const run = async (): Promise<void> => {
      const today = dayKeyOf(Date.now())
      const yesterday = addDays(today, -1)
      const { query, from, to } = get()
      const historyTo = to === null || to > yesterday ? yesterday : to
      const wanted = get().historyLimit
      try {
        const [todayDays, past] = await Promise.all([
          api.list({ text: '', from: today, to: null, before: null, dayLimit: null }),
          api.list({ text: query, from, to: historyTo, before: null, dayLimit: wanted + 1 })
        ])
        if (mine !== revision) return
        loaded = { text: query, from, to, historyTo }
        set({
          status: 'ready',
          error: null,
          today,
          todayEntries: todayDays.flatMap((d) => d.entries),
          history: past.slice(0, wanted),
          historyHasMore: past.length > wanted,
          historyFiltered: noteSearchTerms(query).length > 0 || from !== null || to !== null
        })
      } catch (e) {
        if (mine !== revision) return
        set({ status: 'error', error: message(e) })
      }
    }
    const promise = run().finally(() => {
      if (reloading === promise) reloading = null
    })
    reloading = promise
    return promise
  }

  /** The filters changed: whatever was loaded is for the old ones, so start from the first page. */
  function startOver(): void {
    set({ historyLimit: HISTORY_PAGE_DAYS })
    // An older page still on its way belongs to the old filters.
    revision++
  }

  const reloadSoon = debounce(() => void reload(), SEARCH_DEBOUNCE_MS)

  /** Run a mutation and re-read, answering whether the mutation itself succeeded. */
  async function mutate(op: () => Promise<unknown>, failure: string): Promise<boolean> {
    let ok = true
    try {
      await op()
    } catch (e) {
      ok = false
      reportError(failure, e)
    }
    await reload()
    return ok
  }

  return {
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
    to: null,

    async load() {
      if (get().status === 'idle') set({ status: 'loading', error: null })
      await reload()
    },

    setQuery(text) {
      set({ query: text })
      startOver()
      reloadSoon()
    },

    setRange(from, to) {
      set({ from, to })
      startOver()
      // The reload reads the current text too, so a search still waiting on its pause is covered.
      reloadSoon.cancel()
      void reload()
    },

    async loadOlder() {
      // A reload in flight decides what the history is; the page after it must follow that.
      while (reloading) await reloading
      const { status, history, historyHasMore, loadingOlder } = get()
      if (status !== 'ready' || !historyHasMore || loadingOlder || history.length === 0) return
      // A changed filter that has not been read yet (a search waiting on its pause) means the
      // history on screen is for the old filters, and its next page is not wanted.
      const now = get()
      if (now.query !== loaded.text || now.from !== loaded.from || now.to !== loaded.to) return
      const mine = revision
      set({ loadingOlder: true })
      try {
        const older = await api.list({
          text: loaded.text,
          from: loaded.from,
          to: loaded.historyTo,
          before: history[history.length - 1].day,
          dayLimit: HISTORY_PAGE_DAYS + 1
        })
        // A reload or a filter change has begun since: it brings its own history.
        if (mine !== revision) return
        set({
          historyLimit: get().historyLimit + HISTORY_PAGE_DAYS,
          history: [...history, ...older.slice(0, HISTORY_PAGE_DAYS)],
          historyHasMore: older.length > HISTORY_PAGE_DAYS
        })
      } catch (e) {
        if (mine === revision) reportError('Could not load older notes', e)
      } finally {
        set({ loadingOlder: false })
      }
    },

    add(body) {
      return mutate(() => api.add(body), 'Could not save the note')
    },

    update(id, body) {
      return mutate(() => api.update(id, body), 'Could not save the note')
    },

    async remove(id) {
      await mutate(() => api.remove(id), 'Could not delete the note')
    }
  }
})
