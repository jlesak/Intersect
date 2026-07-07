import { weekStartOf } from '@common/week'
import { useTimeTrackingStore } from '../store'

/**
 * The sidebar rail for the Time Tracking section. The board itself lives in the section's
 * mainComponent, so the rail stays a light hint plus a Refresh control.
 */
export function SidebarTimeTracking() {
  const count = useTimeTrackingStore((s) => s.entries.length)
  const loading = useTimeTrackingStore((s) => s.status === 'loading')
  // The count reflects whatever week is on the board, which may not be the current one.
  const thisWeek = useTimeTrackingStore((s) => s.weekStart) === weekStartOf(Date.now())

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="ix-sidebar__section">
        <span className="ix-eyebrow">
          {count} entries {thisWeek ? 'this week' : 'in shown week'}
        </span>
        <button
          type="button"
          className="ix-btn ix-btn--ghost"
          disabled={loading}
          onClick={() => void useTimeTrackingStore.getState().refresh()}
        >
          {loading && <span className="ix-spinner" aria-hidden />}
          Refresh
        </button>
      </div>
      <div className="ix-sidebar__list">
        <p style={{ padding: '2px 10px', color: 'var(--text-faint)' }}>
          Your weekly worklog: every Claude Code session becomes a card, and meetings or offline
          work can be added by hand.
        </p>
      </div>
    </div>
  )
}
