import { formatDuration } from '@renderer/features/sessions'
import { useNow } from '@renderer/shared/ui/useNow'
import { useTimeTrackingStore } from '../store'

/**
 * Start/Stop for the work timer, with the elapsed span while one runs. Mounted both in the Time
 * Tracking topbar and in the Dashboard's time zone, so it reads the store itself rather than
 * taking the timer as a prop.
 *
 * Start is deliberately one click with nothing to fill in first - the description and issue key
 * are editable while it runs and on the entry afterwards, so recording the time never waits on
 * deciding what to call it.
 */
export function TimerControl() {
  const timer = useTimeTrackingStore((s) => s.timer)
  // Nothing on screen changes by itself while idle, so the clock stops with the timer.
  const now = useNow(timer ? 1000 : null)

  if (!timer) {
    return (
      <div className="ix-timer">
        <button
          type="button"
          className="ix-btn ix-btn--primary ix-timer__action"
          onClick={() => void useTimeTrackingStore.getState().startTimer('', null)}
        >
          Start
        </button>
      </div>
    )
  }

  const what = [timer.description.trim(), timer.issueKey].filter(Boolean).join(' · ')

  return (
    <div className="ix-timer ix-timer--running">
      <span className="ix-timer__elapsed">{formatDuration(Math.max(0, now - timer.startedAt))}</span>
      {what && <span className="ix-timer__what">{what}</span>}
      <button
        type="button"
        className="ix-btn ix-btn--primary ix-timer__action"
        onClick={() => void useTimeTrackingStore.getState().stopTimer()}
      >
        Stop
      </button>
    </div>
  )
}
