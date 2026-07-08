import type { SessionStatus } from '@common/ipc'
import type { AttentionKind } from './pty/attentionMarkers'

/** How a detected hook marker maps onto the session's visible status. */
const KIND_TO_STATUS: Record<AttentionKind, SessionStatus> = {
  idle: 'done',
  permission: 'waiting'
}

/**
 * Collaborators the notifier needs, all injected so the decision logic stays pure and testable.
 * `notify` performs the actual native OS notification - for 'waiting'/'done' alerts and for a
 * session that just started 'working'; which of those actually reach the screen is the injected
 * implementation's decision (it applies the user's notification settings).
 * `broadcastStatus` tells the renderer to recolor the tab for any status, including 'working';
 * `detect` recognises the app-private hook markers in a raw PTY chunk.
 */
export interface SessionNotifierDeps {
  detect(sessionId: string, chunk: string): AttentionKind | null
  notify(sessionId: string, status: SessionStatus): void
  broadcastStatus(sessionId: string, status: SessionStatus): void
  isWindowFocused(): boolean
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
 * Turns the stream of PTY chunks (and user input) into each session's current status. Two rules
 * keep the 'waiting'/'done' alerts quiet: a session the user is already viewing (window focused
 * and it is the active session) never alerts, and a session that already alerted stays silent
 * until the user acknowledges it by opening it - unless it escalates (done -> waiting re-alerts).
 * 'working' recolors the tab on every prompt but reaches notify only on the transition into
 * working (not on every Enter of an already-working session), under the same viewing suppression.
 */
export function createSessionNotifier(deps: SessionNotifierDeps): SessionNotifier {
  let activeSessionId: string | null = null
  // The unacknowledged alert per session, by kind. Keyed by kind (not a plain flag) so an
  // escalation - e.g. an idle session that then needs a permission decision - re-alerts.
  const pending = new Map<string, AttentionKind>()
  // Sessions currently working, so repeated prompts within one turn don't re-notify.
  const working = new Set<string>()

  return {
    onChunk(sessionId, chunk) {
      const kind = deps.detect(sessionId, chunk)
      if (!kind) return
      // Claude asked for attention, so the session is no longer working on the turn.
      working.delete(sessionId)
      const status = KIND_TO_STATUS[kind]
      // The user is already looking at this session - nothing to draw them back to.
      if (deps.isWindowFocused() && sessionId === activeSessionId) return
      // Already flagged with the same kind and not yet acknowledged - don't stack a repeat alert.
      if (pending.get(sessionId) === kind) return
      pending.set(sessionId, kind)
      deps.broadcastStatus(sessionId, status)
      deps.notify(sessionId, status)
    },

    onInput(sessionId) {
      pending.delete(sessionId)
      const startedWorking = !working.has(sessionId)
      working.add(sessionId)
      deps.broadcastStatus(sessionId, 'working')
      if (!startedWorking) return
      if (deps.isWindowFocused() && sessionId === activeSessionId) return
      deps.notify(sessionId, 'working')
    },

    reportActive(sessionId) {
      activeSessionId = sessionId
      if (sessionId) pending.delete(sessionId)
    },

    forget(sessionId) {
      pending.delete(sessionId)
      working.delete(sessionId)
    }
  }
}
