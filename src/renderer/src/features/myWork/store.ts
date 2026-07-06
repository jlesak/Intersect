import { create } from 'zustand'
import {
  JIRA_COLUMNS,
  type JiraBoardResult,
  type JiraColumn,
  type JiraErrorKind,
  type JiraIssue
} from '@common/domain'
import { usePrInboxStore } from '@renderer/features/prInbox'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'

type Status = 'idle' | 'loading' | 'login' | 'ready' | 'error'

interface MyWorkState {
  status: Status
  /** Distinguishes the SSO-expired error card from a generic failure. */
  errorKind: JiraErrorKind | null
  error: string | null
  /** Every unresolved issue assigned to me, as the main process last fetched it. */
  issues: JiraIssue[]
  /** When the shown board was fetched (epoch ms), for the "Last refreshed" subtitle; null before
   * the first successful fetch. Also the marker that stale data exists to fall back to. */
  fetchedAt: number | null
  /** Set once hydrate has kicked off the shared ADO sync, so it runs once per app session. */
  prSyncStarted: boolean
  /** A PR-radar row click waiting for the app layer to open it in the PR Inbox section
   * (cross-slice; see myWorkPrNavWiring, mirroring the sessions slice's pendingResume). */
  pendingPrOpen: { repositoryId: string; prId: number } | null
  hydrate(): Promise<void>
  refresh(): Promise<void>
  /** Run the interactive SSO login (headed browser window), then fetch a fresh board. */
  loginAndRefresh(): Promise<void>
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
  /** Land a failed fetch: keep a stale board visible (with a toast) or show the error state. */
  const fail = (kind: JiraErrorKind, msg: string): void => {
    if (get().fetchedAt !== null) {
      // A previous board exists: keep showing it and surface the failure as a toast.
      set({ status: 'ready' })
      reportError('Could not refresh Jira issues', new Error(msg))
    } else {
      set({ status: 'error', error: msg, errorKind: kind })
    }
  }

  /**
   * One fetch attempt. An auth failure means there is no usable SSO session, so (once per attempt)
   * the interactive login is started automatically and a successful login retries with a forced
   * fresh fetch. A second auth failure lands as an error rather than looping.
   */
  const attempt = async (fetch: () => Promise<JiraBoardResult>, allowLogin: boolean): Promise<void> => {
    try {
      const result = await fetch()
      if (result.ok) {
        set({
          status: 'ready',
          issues: result.issues,
          fetchedAt: result.fetchedAt,
          error: null,
          errorKind: null
        })
        return
      }
      if (result.kind === 'auth' && allowLogin) {
        await loginThenFetch(result.message)
        return
      }
      fail(result.kind, result.message)
    } catch (e) {
      fail('other', message(e))
    }
  }

  /** Force a fresh Jira fetch; any board already on screen stays visible while it runs. */
  const refreshJira = async (): Promise<void> => {
    set({ status: 'loading' })
    await attempt(() => api.refresh(), true)
  }

  /** Run the headed-browser SSO login; a completed login is followed by one forced fresh fetch. */
  const loginThenFetch = async (fallbackMessage: string): Promise<void> => {
    set({ status: 'login' })
    try {
      const login = await api.login()
      if (login.ok) {
        set({ status: 'loading' })
        await attempt(() => api.refresh(), false)
      } else {
        fail('auth', login.message || fallbackMessage)
      }
    } catch (e) {
      fail('auth', message(e))
    }
  }

  return {
    status: 'idle',
    errorKind: null,
    error: null,
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
      set({ status: 'loading', error: null, errorKind: null })
      await attempt(() => api.list(), true)
      // A board served from the persisted snapshot may be old; refresh it in the background
      // (the stale board stays on screen) unless it is fresh enough to be this session's fetch.
      // Jira only: the PR sync for this session was already started above.
      const s = get()
      if (s.status === 'ready' && s.fetchedAt !== null && Date.now() - s.fetchedAt > 60_000) {
        void refreshJira()
      }
    },

    async refresh() {
      // One Refresh serves both halves of the section: the Jira board and the PR radar run in
      // parallel, and prInbox.sync reports its own failures (never rethrows) - no double toast.
      const prSync = usePrInboxStore.getState().sync()
      await refreshJira()
      await prSync
    },

    async loginAndRefresh() {
      await loginThenFetch('The Jira login was not completed.')
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
