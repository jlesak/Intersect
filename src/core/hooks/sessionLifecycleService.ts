import type { PermissionRisk, SessionStatus } from '@common/ipc'
import type { HookEventName } from './hookListener'
import { isTerminalState, transition, type LifecycleEvent, type LifecycleState } from './lifecycle'
import { classifyPermissionRisk, type PendingToolUse } from './permissionRisk'
import { hookCwdMatches } from './sessionResume'

/**
 * Collaborators for the per-session lifecycle bookkeeping, injected so the service can be
 * exercised without a database or notifier. `appendRawEvent` persists every authenticated
 * event BEFORE any guard can reject it, so nested-session and cwd-mismatch events survive
 * as diagnostics. `alert` and `markWorking` feed the existing attention pipeline, which
 * owns dedupe, presence gating, the dock badge, and the user's notification settings.
 */
export interface SessionLifecycleDeps {
  appendRawEvent(sessionId: string, eventName: string, payload: unknown): void
  /** Persist the captured Claude session UUID so the tab resumes this conversation later. */
  storeClaudeSessionId(sessionId: string, claudeSessionId: string): void
  alert(sessionId: string, status: SessionStatus, message?: string, risk?: PermissionRisk): void
  markWorking(sessionId: string): void
  log(message: string): void
}

export interface SessionLifecycleService {
  /** A managed claude PTY was spawned in `cwd`; start tracking its lifecycle from scratch. */
  onSpawn(sessionId: string, cwd: string): void
  /** An authenticated hook event arrived from the listener, tagged with an instance id. */
  onHookEvent(eventName: HookEventName, body: unknown, instanceId: string): void
  /** The user submitted input to the session (local Enter, ahead of any hook round trip). */
  onUserInput(sessionId: string): void
  /** The session's PTY exited - the one authoritative ending; drops all tracking state. */
  onPtyExit(sessionId: string, exitCode: number): void
  /**
   * Whether this session has proven its hook wiring since spawn (at least one cwd-valid
   * event arrived). While true, the PTY marker fallback should stand down - hooks win.
   */
  isHookHealthy(sessionId: string): boolean
  /**
   * Every tracked managed claude session currently in a live (non-terminal) state, with its spawn
   * cwd. This is the canonical live list the quit modal and the suspend-on-quit transaction read;
   * shells are never tracked here, and an exited session has already dropped out of tracking.
   */
  listLive(): { sessionId: string; cwd: string; state: LifecycleState }[]
}

interface TrackedSession {
  cwd: string
  state: LifecycleState
  hookHealthy: boolean
  /** The most recent cwd-valid PreToolUse, feeding the permission-risk classifier. */
  pendingToolUse: PendingToolUse | undefined
}

/** Best-effort read of a string field from an untrusted hook payload. */
function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Routes authenticated hook events (plus the PTY-level truths) into each managed session's
 * lifecycle state, guarding against the ways the raw stream lies:
 * - an unknown instance id (a hook from a session the app is not managing, or one that
 *   already exited) is persisted as a diagnostic and otherwise dropped;
 * - an event whose payload cwd differs from the session's spawn cwd comes from a NESTED
 *   claude (subagent, skill, summarizer) that inherited the instance id - it is persisted
 *   as a diagnostic but must never move the parent's state or overwrite its resume id;
 * - a payload that is not a JSON object (the helper's stdin cap can truncate one) cannot be
 *   trusted to carry a cwd, so it too stays diagnostic-only.
 * Everything that passes the guards marks the session hook-healthy, runs the pure state
 * machine, and surfaces user-visible changes through the injected attention pipeline.
 */
export function createSessionLifecycleService(deps: SessionLifecycleDeps): SessionLifecycleService {
  const sessions = new Map<string, TrackedSession>()

  /** Run one machine event, apply its outputs, and log any state change with its source. */
  function apply(
    sessionId: string,
    session: TrackedSession,
    event: LifecycleEvent,
    source: 'hook' | 'pty'
  ): LifecycleState {
    const previous = session.state
    const result = transition(previous, event)
    session.state = result.state
    for (const output of result.outputs) {
      if (output.kind === 'storeClaudeSessionId') {
        deps.storeClaudeSessionId(sessionId, output.claudeSessionId)
      }
      // clearAttention is realized by markWorking below - the notifier's turn-start path
      // already drops stale pending/acked alerts.
    }
    if (result.state !== previous) {
      deps.log(
        `[lifecycle] ${sessionId}: ${previous} -> ${result.state} (source: ${source}, event: ${event.kind})`
      )
    }
    return result.state
  }

  return {
    onSpawn(sessionId, cwd) {
      // terminal.spawn re-fires on renderer remounts while the PTY is still alive (the
      // session manager no-ops those); tracking must survive them. Only a fresh spawn -
      // nothing tracked, because the exit path cleared it - starts from scratch.
      if (sessions.has(sessionId)) return
      sessions.set(sessionId, {
        cwd,
        state: 'spawning',
        hookHealthy: false,
        pendingToolUse: undefined
      })
    },

    onHookEvent(eventName, body, instanceId) {
      // Raw persistence first: even events the guards below reject are diagnostics.
      deps.appendRawEvent(instanceId, eventName, body)

      const session = sessions.get(instanceId)
      if (!session) {
        deps.log(`[lifecycle] ${instanceId}: ${eventName} for unmanaged instance (diagnostic only)`)
        return
      }
      if (typeof body !== 'object' || body === null) {
        deps.log(`[lifecycle] ${instanceId}: ${eventName} with non-JSON payload (diagnostic only)`)
        return
      }
      const payload = body as Record<string, unknown>
      if (!hookCwdMatches(session.cwd, payload.cwd)) {
        deps.log(
          `[lifecycle] ${instanceId}: ${eventName} from nested cwd ${String(payload.cwd)} (diagnostic only)`
        )
        return
      }

      session.hookHealthy = true

      switch (eventName) {
        case 'SessionStart': {
          const claudeSessionId = stringField(payload, 'session_id')
          if (!claudeSessionId) {
            deps.log(`[lifecycle] ${instanceId}: SessionStart without session_id`)
            return
          }
          apply(instanceId, session, { kind: 'sessionStart', claudeSessionId }, 'hook')
          return
        }
        case 'NotificationPermission': {
          const message = stringField(payload, 'message')
          const state = apply(instanceId, session, { kind: 'notificationPermission' }, 'hook')
          if (state === 'waiting-permission') {
            deps.alert(
              instanceId,
              'waiting',
              message,
              classifyPermissionRisk(message, session.pendingToolUse)
            )
          }
          return
        }
        case 'NotificationIdle': {
          const message = stringField(payload, 'message')
          const state = apply(instanceId, session, { kind: 'notificationIdle' }, 'hook')
          if (state === 'idle-notify') deps.alert(instanceId, 'done', message)
          return
        }
        case 'Stop': {
          const state = apply(instanceId, session, { kind: 'stopHook' }, 'hook')
          if (state === 'waiting-input') deps.alert(instanceId, 'done')
          return
        }
        case 'UserPromptSubmit': {
          session.pendingToolUse = undefined
          apply(instanceId, session, { kind: 'userPromptSubmit' }, 'hook')
          deps.markWorking(instanceId)
          return
        }
        case 'SessionEnd': {
          // Documented no-op: SessionEnd also fires on /clear, /compact, auto-compaction
          // and /resume, so only the PTY exiting may end the session.
          apply(instanceId, session, { kind: 'sessionEnd' }, 'hook')
          return
        }
        case 'PreToolUse': {
          const toolName = stringField(payload, 'tool_name')
          if (toolName) {
            session.pendingToolUse = { toolName, toolInput: payload.tool_input }
          }
          return
        }
      }
    },

    onUserInput(sessionId) {
      const session = sessions.get(sessionId)
      if (!session) return
      // The local Enter is the fastest turn-start signal (and the only one a permission
      // approval produces). The notifier's own onInput path repaints/clears alerts; here we
      // only keep the machine in step.
      apply(sessionId, session, { kind: 'userPromptSubmit' }, 'pty')
    },

    onPtyExit(sessionId, exitCode) {
      const session = sessions.get(sessionId)
      if (!session) return
      apply(sessionId, session, { kind: 'ptyExit', code: exitCode }, 'pty')
      sessions.delete(sessionId)
    },

    isHookHealthy(sessionId) {
      return sessions.get(sessionId)?.hookHealthy ?? false
    },

    listLive() {
      const live: { sessionId: string; cwd: string; state: LifecycleState }[] = []
      for (const [sessionId, session] of sessions) {
        if (!isTerminalState(session.state)) {
          live.push({ sessionId, cwd: session.cwd, state: session.state })
        }
      }
      return live
    }
  }
}
