import type { SessionStatus } from '@common/ipc'
import type { AttentionAlert } from './pty/attentionDetector'
import type { AttentionKind } from './pty/attentionMarkers'

/** How a detected hook marker maps onto the session's visible status. */
const KIND_TO_STATUS: Record<AttentionKind, SessionStatus> = {
  idle: 'done',
  permission: 'waiting',
  stop: 'done'
}

/**
 * Collaborators the notifier needs, all injected so the decision logic stays pure and testable.
 * `notify` performs the actual native OS notification - for 'waiting'/'done' alerts and for a
 * session that just started 'working'; which of those actually reach the screen is the injected
 * implementation's decision (it applies the user's notification settings). `message`, when given,
 * is Claude's own notification text and should be preferred over a generic body.
 * `broadcastStatus` tells the renderer to recolor the tab for any status, including 'working';
 * `detect` recognises the app-private hook markers in a raw PTY chunk.
 * `onPendingChanged` reports how many sessions currently hold an unacknowledged waiting/done
 * alert, for a dock badge or similar count-based indicator; it fires whenever that count changes.
 */
export interface SessionNotifierDeps {
  detect(sessionId: string, chunk: string): AttentionAlert | null
  notify(sessionId: string, status: SessionStatus, message?: string): void
  broadcastStatus(sessionId: string, status: SessionStatus): void
  isWindowFocused(): boolean
  onPendingChanged(count: number): void
}

export interface SessionNotifier {
  /** Feed a raw PTY output chunk; may raise an alert if it signals the session wants input. */
  onChunk(sessionId: string, chunk: string): void
  /**
   * The user submitted a prompt to a Claude session: mark it 'working' and drop any stale
   * unacknowledged alert from the previous turn (it no longer describes the session's state).
   */
  onInput(sessionId: string): void
  /** Renderer reports which session the user is now viewing (null = none); acknowledges it. */
  reportActive(sessionId: string | null): void
  /** Forget a session's alert state (call when its PTY exits) so a respawn can alert again. */
  forget(sessionId: string): void
}

/**
 * Turns the stream of PTY chunks (and user input) into each session's current status. The tab is
 * always repainted for a detected alert, even a viewed one - a session the user is watching should
 * still flip to green when Claude finishes. What viewing suppresses is the *notify*: a session the
 * user is already viewing (window focused and it is the active session) never raises a native
 * notification or dock badge for it, and a session that already alerted stays silent until the user
 * acknowledges it - either by opening it or by having watched it happen - unless it escalates
 * (done -> waiting re-alerts).
 * Dedup is keyed by the resulting status, not the triggering kind: Claude's `Stop` hook and its
 * `idle_prompt` Notification can both fire for the same idle period (Stop immediately, idle_prompt
 * ~60s later as a backstop) and both map to 'done' - keying by kind would let them double-alert.
 * Two maps track "the user hasn't dealt with this status yet": `pending` for a status the user
 * hasn't seen at all (drives the dock badge), `acked` for a status the user has already watched
 * happen or manually acknowledged (never badged, but still suppresses a same-status re-alert from
 * a backstop like idle_prompt). A session is in at most one of the two at a time.
 * 'working' recolors the tab on every prompt but reaches notify only on the transition into
 * working (not on every Enter of an already-working session), under the same viewing suppression.
 */
export function createSessionNotifier(deps: SessionNotifierDeps): SessionNotifier {
  let activeSessionId: string | null = null
  // The unacknowledged alert per session, by resulting status - counted in the dock badge.
  // Escalation (e.g. done -> waiting) overwrites the entry and re-alerts; the same status arriving
  // again while pending does not.
  const pending = new Map<string, SessionStatus>()
  // The status the user already watched happen (or manually acknowledged) but never turned into a
  // pending alert, by resulting status. Not counted in the dock badge. Exists so a later backstop
  // alert (idle_prompt following a Stop the user already watched fire) doesn't notify or badge for
  // a turn the user already saw finish. Escalation past this status still alerts, same as pending.
  const acked = new Map<string, SessionStatus>()
  // Sessions currently working, so repeated prompts within one turn don't re-notify.
  const working = new Set<string>()

  /** Record a session's alert as pending, reporting the new count only when it actually grows. */
  function setPending(sessionId: string, status: SessionStatus): void {
    const isNew = !pending.has(sessionId)
    pending.set(sessionId, status)
    if (isNew) deps.onPendingChanged(pending.size)
  }

  /** Drop a session's pending alert, reporting the new count only when one was actually cleared. */
  function clearPending(sessionId: string): void {
    if (pending.delete(sessionId)) deps.onPendingChanged(pending.size)
  }

  return {
    onChunk(sessionId, chunk) {
      const alert = deps.detect(sessionId, chunk)
      if (!alert) return
      // Claude asked for attention, so the session is no longer working on the turn.
      working.delete(sessionId)
      const status = KIND_TO_STATUS[alert.kind]
      // Repaint the tab for the new status regardless of viewing/dedup - that part is always welcome.
      deps.broadcastStatus(sessionId, status)
      // The user is already looking at this session - they saw it happen, nothing more to alert.
      if (deps.isWindowFocused() && sessionId === activeSessionId) {
        acked.set(sessionId, status)
        return
      }
      // Already flagged (pending or already-acked) with the same status - don't stack a repeat alert.
      if (pending.get(sessionId) === status || acked.get(sessionId) === status) return
      acked.delete(sessionId)
      setPending(sessionId, status)
      deps.notify(sessionId, status, alert.message)
    },

    onInput(sessionId) {
      clearPending(sessionId)
      acked.delete(sessionId)
      const startedWorking = !working.has(sessionId)
      working.add(sessionId)
      deps.broadcastStatus(sessionId, 'working')
      if (!startedWorking) return
      if (deps.isWindowFocused() && sessionId === activeSessionId) return
      deps.notify(sessionId, 'working')
    },

    reportActive(sessionId) {
      activeSessionId = sessionId
      if (!sessionId) return
      // Move any pending alert into acked rather than dropping it outright, so a backstop that
      // fires after the manual acknowledgment still doesn't re-alert for the same status.
      const status = pending.get(sessionId)
      if (status !== undefined) acked.set(sessionId, status)
      clearPending(sessionId)
    },

    forget(sessionId) {
      clearPending(sessionId)
      acked.delete(sessionId)
      working.delete(sessionId)
    }
  }
}
