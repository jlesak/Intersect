import type { MeetingSnapshot } from '@common/domain'
import { formatRelativeTime } from '@renderer/features/myWork'
import { useMeetingsStore } from '@renderer/features/timeTracking'

const localTime = (at: number): string => new Date(at).toLocaleTimeString(undefined, {
  hour: '2-digit', minute: '2-digit'
})

export function ZoneMeetings({ snapshot, today, now, loading }: {
  snapshot: MeetingSnapshot | null
  today: string
  now: number
  loading: boolean
}) {
  const current = snapshot?.day === today ? snapshot : null
  const meetings = current?.meetings ?? []
  return (
    <div className="ix-dash-group ix-dash-meetings">
      <div className="ix-dash-group__head">
        <span className="ix-dash-group__label">Meetings</span>
        <span className="ix-dash-group__count">{meetings.length}</span>
        <span className="ix-dash-meetings__sync">
          {current?.syncedAt ? `Synced ${formatRelativeTime(current.syncedAt, now)}` : 'Not synced today'}
        </span>
        <button type="button" className="ix-btn ix-btn--ghost" disabled={loading}
          onClick={() => void useMeetingsStore.getState().refresh(today)}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {current?.error && <div className="ix-dash-meetings__error" role="alert">
        Refresh failed: {current.error}. {meetings.length > 0 && 'Showing the last sync.'}
      </div>}
      {meetings.length === 0 && !loading && <div className="ix-dash-group__empty">
        {current?.error ? 'Meetings are unavailable.' : 'No meetings today.'}
      </div>}
      {meetings.map((event) => (
        <div className="ix-dash-row ix-dash-meetings__row" key={`${event.source}:${event.externalId}`}>
          <span className="ix-dash-row__main">
            <span className="ix-dash-row__title">{event.subject}</span>
          </span>
          <span className="ix-dash-row__age">
            {event.allDay ? 'All day' : `${localTime(event.startAt)}–${localTime(event.endAt)}`}
          </span>
          {event.joinUrl && <button type="button" className="ix-btn ix-btn--ghost"
            onClick={() => void useMeetingsStore.getState().join(event)}>Join</button>}
        </div>
      ))}
    </div>
  )
}
