/**
 * The three hook-detected states, from Claude's own `idle_prompt`/`permission_prompt` Notification
 * matchers and its `Stop` hook (fires at the end of every assistant turn, well before the ~60s
 * idle_prompt timeout). Detection-layer concept only (main process); the renderer sees the broader
 * SessionStatus, which also includes `working` (inferred from user input, not a hook marker).
 */
export const ATTENTION_KINDS = ['idle', 'permission', 'stop'] as const
export type AttentionKind = (typeof ATTENTION_KINDS)[number]

// The app-private tokens carried inside the OSC 9 sequence Claude Code prints via an injected
// hook. notifSettings's generated hook script builds the sequence from these; the detector never
// scans for a bare token (that would false-trigger on file content or grep output) - only for the
// full ESC ] 9 ; <token> [ ; <base64 message> ] BEL sequence.
export const IDLE_TOKEN = 'INTERSECT_IDLE'
export const PERMISSION_TOKEN = 'INTERSECT_PERMISSION'
export const STOP_TOKEN = 'INTERSECT_STOP'

/** Token-to-kind lookup, shared by the detector (parsing markers back out of the PTY stream). */
export const TOKEN_KINDS: Readonly<Record<string, AttentionKind>> = {
  [IDLE_TOKEN]: 'idle',
  [PERMISSION_TOKEN]: 'permission',
  [STOP_TOKEN]: 'stop'
}

/** How urgently each kind should win when more than one marker lands in the same chunk. */
export const KIND_PRIORITY: Readonly<Record<AttentionKind, number>> = {
  permission: 2,
  idle: 1,
  stop: 0
}

const ESC = '\x1b'
const BEL = '\x07'

/** Opens every marker: an OSC 9 desktop-notification escape, private to Intersect's own tokens. */
export const MARKER_PREFIX = `${ESC}]9;`
/** Closes every marker. */
export const MARKER_TERMINATOR = BEL

/**
 * Builds the exact marker the injected hook script prints: the token, an optional base64-encoded
 * copy of Claude's own notification message, and the terminator. Used by the detector's tests to
 * construct input identical to what the real hook script emits.
 */
export function buildMarker(token: string, message?: string): string {
  const payload = message ? `;${Buffer.from(message, 'utf8').toString('base64')}` : ''
  return `${MARKER_PREFIX}${token}${payload}${MARKER_TERMINATOR}`
}
