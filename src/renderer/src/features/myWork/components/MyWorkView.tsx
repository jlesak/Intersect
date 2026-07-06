import { useEffect, useReducer } from 'react'
import { IconRefresh } from '@renderer/shared/ui/icons'
import { formatRelativeTime, useMyWorkStore } from '../store'
import { JiraBoard, JiraBoardSkeleton } from './JiraBoard'

/**
 * The Jira section's body. Once any board exists (even a stale persisted one) it stays on screen
 * through refreshes and logins, with a banner for the sign-in; the skeleton and full-card states
 * only ever show before the first board.
 */
function JiraSectionBody() {
  const status = useMyWorkStore((s) => s.status)
  const issues = useMyWorkStore((s) => s.issues)
  const error = useMyWorkStore((s) => s.error)
  const errorKind = useMyWorkStore((s) => s.errorKind)
  const hasBoard = useMyWorkStore((s) => s.fetchedAt) !== null

  if (hasBoard) {
    return (
      <>
        {status === 'login' && (
          <div className="ix-mw-loading" style={{ marginBottom: 4 }}>
            <span className="ix-spinner" aria-hidden />
            Jira sign-in required. Complete the SSO login in the browser window that just opened…
          </div>
        )}
        {issues.length === 0 ? (
          <div className="ix-mw-card">
            <div className="ix-mw-empty-inline">
              <strong>All done ✓</strong>
              <span>No unresolved issues assigned to you.</span>
            </div>
          </div>
        ) : (
          <JiraBoard issues={issues} />
        )}
      </>
    )
  }

  if (status === 'idle' || status === 'loading') {
    return (
      <>
        <JiraBoardSkeleton />
        <div className="ix-mw-loading" style={{ marginTop: -4 }}>
          <span className="ix-spinner" aria-hidden />
          Fetching from Jira through a background Claude Code session (jira skill)…
        </div>
      </>
    )
  }

  if (status === 'login') {
    return (
      <>
        <JiraBoardSkeleton />
        <div className="ix-mw-loading" style={{ marginTop: -4 }}>
          <span className="ix-spinner" aria-hidden />
          Jira sign-in required. Complete the SSO login in the browser window that just opened…
        </div>
      </>
    )
  }

  if (status === 'error') {
    const auth = errorKind === 'auth'
    return (
      <div className="ix-mw-card">
        <div className="ix-mw-error">
          <span className="ix-mw-error__title">Could not load Jira issues</span>
          <span className="ix-mw-error__body">
            {auth
              ? 'There is no active Jira SSO session. Sign in again to load the board.'
              : error || 'Something went wrong while fetching the board.'}
          </span>
          <button
            type="button"
            className="ix-btn ix-btn--ghost"
            style={{ alignSelf: 'flex-start' }}
            onClick={() =>
              void (auth
                ? useMyWorkStore.getState().loginAndRefresh()
                : useMyWorkStore.getState().refresh())
            }
          >
            <IconRefresh width={14} height={14} />
            {auth ? 'Log in to Jira' : 'Try again'}
          </button>
        </div>
      </div>
    )
  }

  if (issues.length === 0) {
    return (
      <div className="ix-mw-card">
        <div className="ix-mw-empty-inline">
          <strong>All done ✓</strong>
          <span>No unresolved issues assigned to you.</span>
        </div>
      </div>
    )
  }

  return <JiraBoard issues={issues} />
}

/**
 * The My Work section's main region: a refresh topbar over the Jira board. Fetches the board on
 * first open (idle check), mirroring how SessionsView hydrates. The Jira board fills the top of
 * the page; further work sources will stack below it as their own sections.
 */
export function MyWorkView() {
  const status = useMyWorkStore((s) => s.status)
  const count = useMyWorkStore((s) => s.issues.length)
  const fetchedAt = useMyWorkStore((s) => s.fetchedAt)
  const loading = status === 'idle' || status === 'loading' || status === 'login'

  useEffect(() => {
    const { status } = useMyWorkStore.getState()
    if (status === 'idle') void useMyWorkStore.getState().hydrate()
  }, [])

  // Re-render every minute so the "Last refreshed" subtitle and card ages stay honest.
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const timer = setInterval(tick, 60_000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="ix-main">
      <div className="ix-mywork">
        <div className="ix-mywork__topbar">
          <div>
            <div className="ix-mywork__title">My Work</div>
            {fetchedAt !== null && (
              <div className="ix-mywork__subtitle">
                {status === 'loading'
                  ? 'Refreshing…'
                  : `Last refreshed ${formatRelativeTime(fetchedAt)}`}
              </div>
            )}
          </div>
          <button
            type="button"
            className="ix-btn"
            disabled={loading}
            onClick={() => void useMyWorkStore.getState().refresh()}
          >
            <IconRefresh width={14} height={14} />
            Refresh
          </button>
        </div>

        <section className="ix-mw-section">
          <div className="ix-mw-section__head">
            <span className="ix-eyebrow">Jira · assigned to me</span>
            {status === 'ready' && <span className="ix-mw-section__count">{count}</span>}
            <div className="ix-mw-section__spacer" />
            <span className="ix-mw-section__meta">Sorted by last activity</span>
          </div>
          <JiraSectionBody />
        </section>
      </div>
    </div>
  )
}
