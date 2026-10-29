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

  /**
   * Read Today and the history again. Today is `day >= today` and the history `day < today`, so
   * together they reach every entry there is. Only the newest request may write its answer.
   */
  async function reload(): Promise<void> {
    const mine = ++revision
    const today = dayKeyOf(Date.now())
    const yesterday = addDays(today, -1)
    const { query, from, to } = get()
    const historyTo = to === null || to > yesterday ? yesterday : to
    try {
      const [todayDays, history] = await Promise.all([
        api.list({ text: '', from: today, to: null }),
        api.list({ text: query, from, to: historyTo })
      ])
      if (mine !== revision) return
      set({
        status: 'ready',
        error: null,
        today,
        todayEntries: todayDays.flatMap((d) => d.entries),
        history,
        historyFiltered: noteSearchTerms(query).length > 0 || from !== null || to !== null
      })
    } catch (e) {
      if (mine !== revision) return
      set({ status: 'error', error: message(e) })
    }
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
    query: '',
    from: null,
    to: null,

    async load() {
      if (get().status === 'idle') set({ status: 'loading', error: null })
      await reload()
    },

    setQuery(text) {
      set({ query: text })
      reloadSoon()
    },

    setRange(from, to) {
      set({ from, to })
      // The reload reads the current text too, so a search still waiting on its pause is covered.
      reloadSoon.cancel()
      void reload()
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
