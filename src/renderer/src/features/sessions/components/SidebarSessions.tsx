import { useSessionsStore } from '../store'

/**
 * The sidebar rail for the Sessions section. The list, filters and transcript all live in the
 * section's mainComponent, so the rail stays a light hint plus a count and a Refresh control.
 */
export function SidebarSessions() {
  const total = useSessionsStore((s) => s.all.length)
  const loading = useSessionsStore((s) => s.status === 'loading')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="ix-sidebar__section">
        <span className="ix-eyebrow">{total} sessions</span>
        <button
          type="button"
          className="ix-btn ix-btn--ghost"
          disabled={loading}
          onClick={() => void useSessionsStore.getState().refresh()}
        >
          {loading && <span className="ix-spinner" aria-hidden />}
          Refresh
        </button>
      </div>
      <div className="ix-sidebar__list">
        <p style={{ padding: '2px 10px', color: 'var(--text-faint)' }}>
          Search your past Claude Code sessions, read a transcript, and resume one in a terminal.
        </p>
      </div>
    </div>
  )
}
