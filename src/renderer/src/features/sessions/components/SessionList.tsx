import { useShallow } from 'zustand/react/shallow'
import { selectFiltered, useSessionsStore } from '../store'
import { SessionRow } from './SessionRow'

/** The filtered, descending-by-activity list of sessions in the main area's left column. */
export function SessionList() {
  const sessions = useSessionsStore(useShallow(selectFiltered))
  const query = useSessionsStore((s) => s.query)
  const selectedId = useSessionsStore((s) => s.selectedId)
  const status = useSessionsStore((s) => s.status)

  if (status === 'loading' && sessions.length === 0) {
    return (
      <div className="ix-sessions-list ix-sessions-list--empty">
        <span className="ix-faint">Loading sessions…</span>
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="ix-sessions-list ix-sessions-list--empty">
        <span className="ix-faint">No sessions match the current filters.</span>
      </div>
    )
  }

  return (
    <div className="ix-sessions-list">
      {sessions.map((s) => (
        <SessionRow key={s.id} session={s} active={s.id === selectedId} query={query} />
      ))}
    </div>
  )
}
