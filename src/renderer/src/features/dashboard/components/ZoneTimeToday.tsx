import { formatTotal, TimerControl, useTimeTrackingStore } from '@renderer/features/timeTracking'
import type { TimeToday } from '../zones'
import { ZoneNote, type NoteAction } from './ZoneNote'

/** What each figureless state means, phrased as what is true rather than as a failure. */
const NOTE: Record<Exclude<TimeToday['kind'], 'logged'>, string> = {
  weekend: 'The weekday board does not track weekends - a span logged now lands on its true day.',
  otherWeek: 'The worklog is showing another week.',
  failed: "Today's worklog could not be loaded.",
  loading: "Reading today's worklog…"
}

/**
 * The way out of a state that has no figure, where one exists. A failed read is retried on the week
 * that is shown rather than on this one, so retrying never drags the Time Tracking board out from
 * under the user; the wrong week is the one case where moving it is what was asked for.
 */
function noteAction(kind: Exclude<TimeToday['kind'], 'logged'>): NoteAction | undefined {
  if (kind === 'otherWeek') {
    return {
      label: 'Show this week',
      onClick: () => void useTimeTrackingStore.getState().goToday()
    }
  }
  if (kind === 'failed') {
    return {
      label: 'Try again',
      onClick: () => {
        const store = useTimeTrackingStore.getState()
        void store.loadWeek(store.weekStart)
      }
    }
  }
  return undefined
}

/**
 * Zone 3 - what is on today's worklog, and the one control that adds to it.
 *
 * A figure appears only when the worklog holds this week and has actually arrived. Every other case
 * says which case it is: `0m` is a statement about a day, and printing it for a week that failed or
 * has not landed yet would be the surface asserting something it does not know, on the view the app
 * opens on.
 *
 * The timer stays available in all of them: recording time is never the thing that has to wait.
 */
export function ZoneTimeToday({ state }: { state: TimeToday }) {
  return (
    <section className="ix-dash-zone">
      <div className="ix-dash-zone__head">
        <span className="ix-eyebrow ix-dash-zone__title">Time today</span>
      </div>
      {state.kind === 'logged' ? (
        <div className="ix-dash-time__logged">
          <span className="ix-dash-time__total">{formatTotal(state.loggedMs)}</span>
          <span className="ix-dash-time__label">logged today</span>
        </div>
      ) : (
        <ZoneNote
          className="ix-dash-time__note"
          note={NOTE[state.kind]}
          action={noteAction(state.kind)}
        />
      )}
      <TimerControl />
    </section>
  )
}
