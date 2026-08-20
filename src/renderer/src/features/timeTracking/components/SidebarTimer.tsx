import { useTimeTrackingStore } from '../store'
import { TimerControl } from './TimerControl'

/**
 * The running timer in the app shell, so a timer started in Time Tracking stays visible and
 * stoppable from the PR board, a terminal, or anywhere else the user has gone. It renders nothing
 * while nothing runs: an idle app would otherwise carry a second Start button competing with the
 * one in the Time Tracking topbar.
 *
 * The elapsed figure ticks once a second inside TimerControl alone, so the surrounding sidebar
 * (project pins, workspaces, usage) is never re-rendered by the clock.
 */
export function SidebarTimer() {
  const running = useTimeTrackingStore((s) => s.timer !== null)
  if (!running) return null

  return (
    <div className="ix-sidebar__timer">
      <TimerControl />
    </div>
  )
}

/** The rail marker for a running timer, so the Time Tracking button says so on the icon rail. */
export function TimerRailBadge() {
  const running = useTimeTrackingStore((s) => s.timer !== null)
  if (!running) return null
  return <span className="ix-rail__badge ix-rail__badge--dot" data-testid="timer-badge" />
}
