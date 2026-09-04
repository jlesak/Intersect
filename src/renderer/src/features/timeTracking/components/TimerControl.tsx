import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useNow } from '@renderer/shared/ui/useNow'
import { useTimeTrackingStore } from '../store'
import { formatElapsed } from '../time'

/**
 * Start/Stop for the work timer, with the elapsed span and the label while one runs. Mounted both
 * in the Time Tracking topbar and in the Dashboard's time zone, so it reads the store itself rather
 * than taking the timer as a prop.
 *
 * Start is deliberately one click with nothing to fill in first, so recording the time never waits
 * on deciding what to call it. Naming it is the very next keystroke instead: the label field is
 * focused the moment the clock starts, and stays editable for the whole span - a name typed at
 * 09:00 and corrected at 09:40 both reach the logged entry, because the core reads the description
 * off the running row at the moment it stops.
 */
export function TimerControl() {
  const timer = useTimeTrackingStore((s) => s.timer)
  // Nothing on screen changes by itself while idle, so the clock stops with the timer.
  const now = useNow(timer ? 1000 : null)
  const [busy, setBusy] = useState(false)
  // The disabled attribute only bites after a re-render, and the two clicks of a double-click can
  // both land before one happens - so the guard that actually holds is this one, not the styling.
  const inFlight = useRef(false)
  // The label being typed. Local, so a keystroke is not a round trip to main; the store stays the
  // authority and re-seeds the draft whenever main's copy of it changes.
  const [label, setLabel] = useState(timer?.description ?? '')
  const labelField = useRef<HTMLInputElement>(null)
  // A ref (not state) so the Escape keydown is already visible to the blur it triggers.
  const discarding = useRef(false)
  // Set by this control's own Start, so the timer only takes the keyboard on the surface the user
  // actually clicked - the same control is mounted on two or three surfaces at once.
  const focusOnStart = useRef(false)

  useEffect(() => setLabel(timer?.description ?? ''), [timer?.description])

  useEffect(() => {
    if (!timer || !focusOnStart.current) return
    focusOnStart.current = false
    labelField.current?.focus()
  }, [timer])

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

  /**
   * Save the typed label against the running timer. The timer is read from the store rather than
   * from the render that built this handler, so a commit racing an earlier one compares against
   * main's latest answer. A failed save leaves the text on screen: the toast has told the user, and
   * their next Enter or blur is how they retry.
   */
  async function commitLabel(): Promise<void> {
    if (discarding.current) {
      discarding.current = false
      setLabel(useTimeTrackingStore.getState().timer?.description ?? '')
      return
    }
    const next = label.trim()
    const running = useTimeTrackingStore.getState().timer
    // Untouched text is not an edit, and a timer stopped from another surface has nothing to save.
    if (!running || next === running.description) return
    await useTimeTrackingStore.getState().updateTimer(next, running.issueKey)
  }

  /** Blur on Enter so the input's onBlur is the single commit path; Escape discards first. */
  function keyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') e.currentTarget.blur()
    if (e.key === 'Escape') {
      discarding.current = true
      e.currentTarget.blur()
    }
  }

  if (!timer) {
    return (
      <div className="ix-timer">
        <button
          type="button"
          className="ix-btn ix-btn--primary ix-timer__action"
          disabled={busy}
          onClick={() =>
            run(async () => {
              focusOnStart.current = true
              await useTimeTrackingStore.getState().startTimer('', null)
              // A start that failed must not leave a claim on the keyboard for whichever surface
              // starts the next timer.
              if (!useTimeTrackingStore.getState().timer) focusOnStart.current = false
            })
          }
        >
          Start
        </button>
      </div>
    )
  }

  return (
    <div className="ix-timer ix-timer--running">
      <span className="ix-timer__elapsed">{formatElapsed(now - timer.startedAt)}</span>
      <input
        ref={labelField}
        className="ix-input ix-timer__label"
        value={label}
        placeholder="Label (e.g. Code review)"
        aria-label="What the timer is tracking"
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={keyDown}
        onBlur={() => void commitLabel()}
      />
      {timer.issueKey && <span className="ix-timer__what">{timer.issueKey}</span>}
      <button
        type="button"
        className="ix-btn ix-btn--primary ix-timer__action"
        disabled={busy}
        onClick={() =>
          run(async () => {
            // Clicking Stop blurs the field first in a browser, but a Stop reached by keyboard or
            // from another surface does not - and a label typed but never committed would be lost
            // with the span it named. Saving it here, before the stop, is what makes that safe.
            await commitLabel()
            await useTimeTrackingStore.getState().stopTimer()
          })
        }
      >
        Stop
      </button>
    </div>
  )
}
