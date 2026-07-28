import { useRef, useState } from 'react'
import { useNow } from '@renderer/shared/ui/useNow'
import { useTimeTrackingStore } from '../store'
import { formatElapsed } from '../time'

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
  const [busy, setBusy] = useState(false)
  // The disabled attribute only bites after a re-render, and the two clicks of a double-click can
  // both land before one happens - so the guard that actually holds is this one, not the styling.
  const inFlight = useRef(false)

  /**
   * Starting and stopping are round trips to main. A second click while one is unanswered either
   * reports a failure the user did nothing wrong to cause, or starts a timer and discards it in
   * the same gesture, so the control refuses until its own call has come back.
   */
  function run(action: () => Promise<void>): void {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    void action().finally(() => {
      inFlight.current = false
      setBusy(false)
    })
  }

  if (!timer) {
    return (
      <div className="ix-timer">
        <button
          type="button"
          className="ix-btn ix-btn--primary ix-timer__action"
          disabled={busy}
          onClick={() => run(() => useTimeTrackingStore.getState().startTimer('', null))}
        >
          Start
        </button>
      </div>
    )
  }

  const what = [timer.description.trim(), timer.issueKey].filter(Boolean).join(' · ')

  return (
    <div className="ix-timer ix-timer--running">
      <span className="ix-timer__elapsed">{formatElapsed(now - timer.startedAt)}</span>
      {what && <span className="ix-timer__what">{what}</span>}
      <button
        type="button"
        className="ix-btn ix-btn--primary ix-timer__action"
        disabled={busy}
        onClick={() => run(() => useTimeTrackingStore.getState().stopTimer())}
      >
        Stop
      </button>
    </div>
  )
}
