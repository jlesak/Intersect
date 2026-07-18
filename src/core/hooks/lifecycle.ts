/**
 * The hook-driven lifecycle of one managed Claude session, as a pure transition function.
 * States describe what the session is doing from the app's point of view: `spawning` covers
 * the window between the PTY launch and Claude's own SessionStart hook; `working` is an
 * active turn; the three waiting states distinguish why Claude stopped (a permission
 * decision, end of turn, or Claude's own ~60s idle backstop); `finished`/`crashed` are
 * terminal and only ever entered through the PTY exiting - hook events can never end a
 * session, because Claude also fires SessionEnd on mid-life rollovers.
 */
export const LIFECYCLE_STATES = [
  'spawning',
  'working',
  'waiting-permission',
  'waiting-input',
  'idle-notify',
  'finished',
  'crashed'
] as const
export type LifecycleState = (typeof LIFECYCLE_STATES)[number]

/**
 * Everything that can move a session's lifecycle. Hook events carry Claude's own view
 * (sessionStart through sessionEnd); ptyData/ptyExit come from the PTY the session runs in
 * and are the only process-level truths - ptyExit in particular is the sole authority on a
 * session ending.
 */
export type LifecycleEvent =
  | { kind: 'sessionStart'; claudeSessionId: string }
  | { kind: 'notificationPermission' }
  | { kind: 'notificationIdle' }
  | { kind: 'stopHook' }
  | { kind: 'userPromptSubmit' }
  | { kind: 'sessionEnd' }
  | { kind: 'ptyData' }
  | { kind: 'ptyExit'; code: number }

/**
 * Side effects a transition asks its caller to perform. `storeClaudeSessionId` persists the
 * captured Claude session UUID so the tab can resume the conversation after a restart;
 * `clearAttention` drops any outstanding alert because the user just acted on the session.
 */
export type LifecycleOutput =
  | { kind: 'storeClaudeSessionId'; claudeSessionId: string }
  | { kind: 'clearAttention' }

export interface LifecycleTransition {
  state: LifecycleState
  outputs: LifecycleOutput[]
}

const TERMINAL: readonly LifecycleState[] = ['finished', 'crashed']

/**
 * Pure transition function - no clocks, no I/O, fully table-testable. The rules that carry
 * real-world weight:
 * - Terminal states absorb every event; nothing revives an exited session.
 * - sessionStart always re-emits storeClaudeSessionId (Claude mints a fresh session UUID on
 *   /clear rollovers, and the newest one is the only resumable id), but only the very first
 *   one moves spawning -> working.
 * - stopHook while waiting-permission is a no-op: the permission question is still on
 *   screen and outranks "turn ended".
 * - notificationIdle is Claude's own idle backstop; it too never downgrades a pending
 *   permission request.
 * - ptyData only wakes the two "turn is over" states - output during waiting-permission is
 *   just the prompt repainting, not an answer.
 * - sessionEnd is deliberately a no-op: Claude fires it on /clear, /compact, auto-compaction
 *   and /resume, so it cannot be trusted as an ending. Only ptyExit ends a session, and a
 *   nonzero code means it crashed rather than finished.
 */
export function transition(state: LifecycleState, event: LifecycleEvent): LifecycleTransition {
  if (TERMINAL.includes(state)) return { state, outputs: [] }

  switch (event.kind) {
    case 'sessionStart':
      return {
        state: state === 'spawning' ? 'working' : state,
        outputs: [{ kind: 'storeClaudeSessionId', claudeSessionId: event.claudeSessionId }]
      }

    case 'notificationPermission':
      return { state: 'waiting-permission', outputs: [] }

    case 'notificationIdle':
      if (state === 'waiting-permission') return { state, outputs: [] }
      return { state: 'idle-notify', outputs: [] }

    case 'stopHook':
      if (state === 'waiting-permission') return { state, outputs: [] }
      return { state: 'waiting-input', outputs: [] }

    case 'userPromptSubmit':
      return { state: 'working', outputs: [{ kind: 'clearAttention' }] }

    case 'ptyData':
      if (state === 'waiting-input' || state === 'idle-notify') {
        return { state: 'working', outputs: [] }
      }
      return { state, outputs: [] }

    case 'sessionEnd':
      return { state, outputs: [] }

    case 'ptyExit':
      return { state: event.code === 0 ? 'finished' : 'crashed', outputs: [] }
  }
}
