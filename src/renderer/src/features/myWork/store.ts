import { create } from 'zustand'
import {
  GLOBAL_JIRA_SOURCE,
  JIRA_COLUMNS,
  type JiraBoardSnapshot,
  type JiraColumn,
  type JiraIssue,
  type JiraIssueSnapshot,
  type JiraSyncErrorKind
} from '@common/domain'
import { usePrInboxStore } from '@renderer/features/prInbox'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'

type Status = 'idle' | 'loading' | 'login' | 'ready' | 'error'

interface MyWorkState {
  status: Status
  /** Distinguishes the SSO-expired error from not-configured/network/server/other failures. */
  errorKind: JiraSyncErrorKind | null
  error: string | null
  /** True when the last fetch was cut short by the pagination ceiling (issues may be missing). */
  partial: boolean
  /** Every issue of the global board still present remotely, as the core last cached it. */
  issues: JiraIssueSnapshot[]
  /** When the shown board was last successfully fetched (epoch ms); null before the first
   * successful fetch. Also the marker that a last-good board exists to fall back to. */
  fetchedAt: number | null
  /** Set once hydrate has kicked off the shared ADO sync, so it runs once per app session. */
  prSyncStarted: boolean
  /** A PR-radar row click waiting for the app layer to open it in the PR Inbox section
   * (cross-slice; see myWorkPrNavWiring, mirroring the sessions slice's pendingResume). */
  pendingPrOpen: { repositoryId: string; prId: number } | null
  hydrate(): Promise<void>
  refresh(): Promise<void>
  /** Run the interactive SSO login (headed browser window), then fetch a fresh board. Only ever
   * invoked from an explicit user click - an auth failure never opens the login by itself. */
  loginAndRefresh(): Promise<void>
  /** Listen for completed background refreshes pushed from the core; returns an unsubscribe fn. */
  subscribe(): () => void
  /** Open the issue in the system default browser (no in-app navigation). */
  openIssue(issue: JiraIssue): void
  /** Ask the app shell to show this PR in the PR Inbox section (recorded as intent only). */
  openPr(repositoryId: string, prId: number): void
  clearPrOpen(): void
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The board's issues grouped per column, each column sorted by last activity (newest first). */
export function groupByColumn(issues: JiraIssue[]): Record<JiraColumn, JiraIssue[]> {
  const board = { todo: [], progress: [], waiting: [], review: [], test: [] } as Record<
    JiraColumn,
    JiraIssue[]
  >
  for (const issue of issues) board[issue.column].push(issue)
  for (const column of JIRA_COLUMNS) board[column].sort((a, b) => b.updatedAt - a.updatedAt)
  return board
}

/** Compact "how long ago" label: just now, 12m ago, 3h ago, yesterday, 4d ago. */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  if (timestamp <= 0) return ''
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days < 2 ? 'yesterday' : `${days}d ago`
}

export const useMyWorkStore = create<MyWorkState>()((set, get) => {
  /**
   * Land a board envelope from the core. A board that fetched at least once renders alongside
   * any sync error (the error shows as an inline warning); an error with nothing to fall back
   * to is the full error state. An empty cold-start envelope means the core's background
   * refresh is still running - the loading state holds until the change push delivers it.
   */
  const apply = (board: JiraBoardSnapshot): void => {
    if (board.fetchedAt === null && board.error === null) {
      set({ status: 'loading' })
      return
    }
    if (board.fetchedAt === null && board.error !== null) {
      set({
        status: 'error',
        error: board.error.message,
        errorKind: board.error.kind,
        issues: [],
        fetchedAt: null,
        partial: false
      })
      return
    }
    set({
      status: 'ready',
      issues: board.issues.filter((issue) => !issue.absent),
      fetchedAt: board.fetchedAt,
      partial: board.partial,
      error: board.error?.message ?? null,
      errorKind: board.error?.kind ?? null
    })
  }

  /** Land a rejected IPC call: keep a stale board visible, or show the error state. */
  const fail = (kind: JiraSyncErrorKind, msg: string): void => {
    if (get().fetchedAt !== null) {
      set({ status: 'ready', error: msg, errorKind: kind })
    } else {
      set({ status: 'error', error: msg, errorKind: kind })
    }
  }

  return {
    status: 'idle',
    errorKind: null,
    error: null,
    partial: false,
    issues: [],
    fetchedAt: null,
    prSyncStarted: false,
    pendingPrOpen: null,

    async hydrate() {
      // The PR radar shares this section's lifecycle: opening My Work also kicks off one ADO sync
      // per app session. The prInbox store already serves its SQLite cache from boot, so PR cards
      // show instantly while the sync runs. This automatic sync is quiet: a machine without ADO
      // configured must not toast an error on every boot just for landing on this section.
      if (!get().prSyncStarted) {
        set({ prSyncStarted: true })
        void usePrInboxStore.getState().sync({ quiet: true })
      }
      if (get().fetchedAt === null) set({ status: 'loading' })
      try {
        // The core paints its cache immediately and refreshes in the background when stale;
        // the completion push (see subscribe) re-runs this fetch to land the fresh board.
        apply(await api.list())
      } catch (e) {
        fail('other', message(e))
      }
    },

    async refresh() {
      // One Refresh serves both halves of the section: the Jira board and the PR radar run in
      // parallel, and prInbox.sync reports its own failures (never rethrows) - no double toast.
      const prSync = usePrInboxStore.getState().sync()
      set({ status: 'loading' })
      try {
        apply(await api.refresh())
      } catch (e) {
        fail('other', message(e))
      }
      await prSync
    },

    async loginAndRefresh() {
      set({ status: 'login' })
      try {
        const login = await api.login()
        if (login.ok) {
          set({ status: 'loading' })
          apply(await api.refresh())
        } else {
          fail('auth', login.message || 'The Jira login was not completed.')
        }
      } catch (e) {
        fail('auth', message(e))
      }
    },

    subscribe() {
      return api.onChanged((event) => {
        if (event.sourceKey !== GLOBAL_JIRA_SOURCE) return
        // A background refresh finished; pick up its outcome quietly (no loading flicker).
        api.list().then(apply, () => {})
      })
    },

    openIssue(issue) {
      api.openExternal(issue.url).catch((e) => reportError('Could not open the issue', e))
    },

    openPr(repositoryId, prId) {
      set({ pendingPrOpen: { repositoryId, prId } })
    },

    clearPrOpen() {
      set({ pendingPrOpen: null })
    }
  }
})
