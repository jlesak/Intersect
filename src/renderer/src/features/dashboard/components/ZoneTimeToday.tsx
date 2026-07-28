import { formatTotal, TimerControl, useTimeTrackingStore } from '@renderer/features/timeTracking'

/**
 * Zone 3 - what is on today's worklog, and the one control that adds to it.
 *
 * Three states, deliberately distinct. A total is the ordinary case. A weekend is stated as such,
 * because the board excludes Saturday and Sunday by design and `0m` there would read as a day of
 * work gone missing. A worklog showing some other week has no figure to give at all, so it offers
 * the way back rather than a number from the wrong week - and it never loads the current week by
 * itself, which would silently drag the Time Tracking board back under the user.
 *
 * The timer stays available in all three: recording time is never the thing that has to wait.
 */
export function ZoneTimeToday({
  loggedMs,
  weekend
}: {
  loggedMs: number | null
  weekend: boolean
}) {
  return (
    <section className="ix-dash-zone">
      <div className="ix-dash-zone__head">
        <span className="ix-eyebrow ix-dash-zone__title">Time today</span>
      </div>
      {weekend ? (
        <div className="ix-dash-time__note">
          The weekday board does not track weekends - a span logged now lands on its true day.
        </div>
      ) : loggedMs === null ? (
        <div className="ix-dash-time__wrongweek">
          <span className="ix-dash-time__note">The worklog is showing another week.</span>
          <button
            type="button"
            className="ix-btn ix-btn--ghost ix-dash-time__week"
            onClick={() => void useTimeTrackingStore.getState().goToday()}
          >
            Show this week
          </button>
        </div>
      ) : (
        <div className="ix-dash-time__logged">
          <span className="ix-dash-time__total">{formatTotal(loggedMs)}</span>
          <span className="ix-dash-time__label">logged today</span>
        </div>
      )}
      <TimerControl />
    </section>
  )
}
