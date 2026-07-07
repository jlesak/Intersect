import { useOneOnOneStore } from '../store'

/**
 * The sidebar rail for the 1:1 section. The form and history live in the section's
 * mainComponent, so the rail stays a light running-count plus a hint.
 */
export function SidebarOneOnOne() {
  const running = useOneOnOneStore((s) => s.runs.filter((r) => r.status === 'running').length)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="ix-sidebar__section">
        <span className="ix-eyebrow">
          {running} running {running === 1 ? 'workflow' : 'workflows'}
        </span>
      </div>
      <div className="ix-sidebar__list">
        <p style={{ padding: '2px 10px', color: 'var(--text-faint)' }}>
          Process a 1:1 recording into a Notion note and Slack summary, or prepare a briefing for
          an upcoming 1:1. Runs happen in hidden Claude Code sessions.
        </p>
      </div>
    </div>
  )
}
