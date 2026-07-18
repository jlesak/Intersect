import { useMyWorkStore } from '../store'

/**
 * The sidebar rail for the My Work section: an issue count, a Refresh control, and a short hint.
 * The board itself lives in the section's mainComponent.
 */
export function SidebarMyWork() {
  const total = useMyWorkStore((s) => s.issues.length)
  const loading = useMyWorkStore((s) => s.status === 'loading')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="ix-sidebar__section">
        <span className="ix-eyebrow">{total} issues</span>
        <button
          type="button"
          className="ix-btn ix-btn--ghost"
          disabled={loading}
          onClick={() => void useMyWorkStore.getState().refresh()}
        >
          {loading && <span className="ix-spinner" aria-hidden />}
          Refresh
        </button>
      </div>
      <div className="ix-sidebar__list">
        <p style={{ padding: '2px 10px', color: 'var(--text-faint)' }}>
          Your unresolved Jira issues on one board, fetched directly and read-only with your
          browser SSO session - no API token involved.
        </p>
      </div>
    </div>
  )
}
