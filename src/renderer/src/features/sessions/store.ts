import type { SessionSummary, SessionTranscript } from '@common/domain'
import { createStore } from '@renderer/shared/store/createStore'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'
import { scoreSession } from './search'

type Status = 'idle' | 'loading' | 'ready' | 'error'

interface SessionsState {
  status: Status
  error: string | null
  /** Every indexed session, newest activity first (the order main returns). */
  all: SessionSummary[]
  // Filters applied locally by selectFiltered.
  query: string
  /** Inclusive lower bound on lastTimestamp (epoch ms, start of the chosen day), or null. */
  from: number | null
  /** Inclusive upper bound on lastTimestamp (epoch ms, end of the chosen day), or null. */
  to: number | null
  /** Selected folderNames, or null to mean every folder (the default all-checked state). */
  folders: string[] | null
  selectedId: string | null
  transcript: SessionTranscript | null
  transcriptStatus: Status
  /**
   * A session the user asked to resume, handed to the app layer which owns the cross-slice
   * workspace/tab coordination. This slice only records the intent; it never imports the
   * workspaces/tabs/shell stores itself.
   */
  pendingResume: SessionSummary | null
  /**
   * The session whose resume is under way, set by the app layer that performs it. Resuming spans a
   * workspace, its tabs and a terminal launch, so the action that started it needs to say it is
   * still working rather than look like it did nothing.
   */
  resumingId: string | null
  hydrate(): Promise<void>
  refresh(): Promise<void>
  setQuery(query: string): void
  setRange(from: number | null, to: number | null): void
  toggleFolder(folderName: string): void
  setFolders(folders: string[] | null): void
  select(id: string): Promise<void>
  requestResume(summary: SessionSummary): void
  clearResume(): void
  markResuming(id: string | null): void
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The default date filter: the last 7 days including today, as epoch-ms day bounds. `from` is the
 * start of the day six days ago; `to` is the end of today. Computed once when the store is created.
 */
export function defaultDateRange(): { from: number; to: number } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0)
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
  return { from: start.getTime(), to: end.getTime() }
}

/**
 * The sessions passing every active filter. The date range bounds lastTimestamp and the folder
 * filter keeps only selected folderNames; both preserve the store's descending-by-activity order.
 * A search query then narrows further to the sessions whose title or one of whose prompts matches
 * it, and reorders those best match first - recency stops being the useful ordering the moment the
 * user says what they are looking for.
 */
export function selectFiltered(state: SessionsState): SessionSummary[] {
  const query = state.query.trim()
  const folderSet = state.folders ? new Set(state.folders) : null
  const inRange = state.all.filter((s) => {
    if (state.from !== null && s.lastTimestamp < state.from) return false
    if (state.to !== null && s.lastTimestamp > state.to) return false
    if (folderSet && !folderSet.has(s.folderName)) return false
    return true
  })
  if (query === '') return inRange

  return inRange
    .map((session, index) => ({ session, index, score: scoreSession(query, session) }))
    .filter((entry): entry is { session: SessionSummary; index: number; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.session)
}

/** The distinct folderNames present in the index, sorted, for the folder filter UI. */
export function selectFolders(state: SessionsState): string[] {
  return [...new Set(state.all.map((s) => s.folderName))].sort((a, b) => a.localeCompare(b))
}

/** Human-readable session length, e.g. `3h 12m`, `48m`, `<1m`. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000)
  if (totalMinutes < 1) return '<1m'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

export const useSessionsStore = createStore<SessionsState>()((set, get) => ({
  status: 'idle',
  error: null,
  all: [],
  query: '',
  ...defaultDateRange(),
  folders: null,
  selectedId: null,
  transcript: null,
  transcriptStatus: 'idle',
  pendingResume: null,
  resumingId: null,

  async hydrate() {
    set({ status: 'loading', error: null })
    try {
      const all = await api.list()
      set({ status: 'ready', all })
    } catch (e) {
      set({ status: 'error', error: message(e) })
    }
  },

  async refresh() {
    set({ status: 'loading' })
    try {
      const all = await api.refresh()
      set({ status: 'ready', all })
    } catch (e) {
      set({ status: get().all.length > 0 ? 'ready' : 'error' })
      reportError('Could not refresh sessions', e)
    }
  },

  setQuery(query) {
    set({ query })
  },

  setRange(from, to) {
    set({ from, to })
  },

  toggleFolder(folderName) {
    const allFolders = selectFolders(get())
    const current = new Set(get().folders ?? allFolders)
    if (current.has(folderName)) current.delete(folderName)
    else current.add(folderName)
    // Collapse a fully-checked selection back to null (the "all folders" default).
    set({ folders: current.size === allFolders.length ? null : [...current].sort() })
  },

  setFolders(folders) {
    set({ folders })
  },

  async select(id) {
    set({ selectedId: id, transcript: null, transcriptStatus: 'loading' })
    try {
      const transcript = await api.getTranscript(id)
      // Drop a stale response if the selection changed while awaiting.
      if (get().selectedId !== id) return
      set({ transcript, transcriptStatus: 'ready' })
    } catch (e) {
      if (get().selectedId !== id) return
      set({ transcriptStatus: 'error' })
      reportError('Could not load the transcript', e)
    }
  },

  requestResume(summary) {
    set({ pendingResume: summary })
  },

  clearResume() {
    set({ pendingResume: null })
  },

  markResuming(id) {
    set({ resumingId: id })
  }
}))
