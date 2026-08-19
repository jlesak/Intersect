import type { Workspace } from '@common/domain'
import type { SessionStatus } from '@common/ipc'
import type { LiveSession } from '@renderer/features/attention'
import { formatRelativeTime } from '@renderer/features/myWork'
import { useDashboardNavStore } from '../store'

/** What each status means to the user, phrased as what it is asking of them. */
const STATE_LABEL: Record<SessionStatus, string> = {
  waiting: 'waiting for you',
  done: 'finished',
  working: 'working'
}

/**
 * Zone 2 - the Claude Code sessions that currently carry a status, most urgent first.
 *
 * Only the two states that ask something of the user get a way in: a session that is still working
 * needs nothing, and offering to jump into it would invite interrupting it. Sessions with no
 * attention state at all are absent by design - having nothing to report is the whole point.
 *
 * Rows are named by their workspace only. The tabs slice holds one workspace at a time, so no tab
 * title exists for a session in a background workspace, and guessing one would be worse than
 * naming the folder the work is happening in.
 */
export function ZoneSessions({
  sessions,
  workspacesById,
  now
}: {
  sessions: LiveSession[]
  workspacesById: Record<string, Workspace>
  now: number
}) {
  return (
    <section className="ix-dash-zone">
      <div className="ix-dash-zone__head">
        <span className="ix-eyebrow ix-dash-zone__title">Running sessions</span>
        <span className="ix-dash-zone__count">{sessions.length}</span>
      </div>
      {sessions.length === 0 ? (
        <div className="ix-dash-sessions__empty">No Claude session is asking for anything.</div>
      ) : (
        sessions.map((session) => (
          <div key={session.sessionId} className="ix-dash-session">
            <span
              className={`ix-dash-session__dot ix-dash-session__dot--${session.status}`}
              aria-hidden
            />
            <span className="ix-dash-row__main">
              <span className="ix-dash-session__name">
                {workspacesById[session.workspaceId]?.name ?? 'Unknown workspace'}
              </span>
              <span className="ix-dash-session__state">
                {STATE_LABEL[session.status]} · {formatRelativeTime(session.since, now)}
              </span>
            </span>
            {session.status !== 'working' && (
              <button
                type="button"
                className={`ix-btn ix-dash-session__go ${
                  session.status === 'waiting' ? 'ix-btn--primary' : 'ix-btn--ghost'
                }`}
                onClick={() => useDashboardNavStore.getState().goToSession(session.sessionId)}
              >
                Go to
              </button>
            )}
          </div>
        ))
      )}
    </section>
  )
}
