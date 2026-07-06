/**
 * The two hook-detected states, from Claude's own `idle_prompt`/`permission_prompt` notification
 * matchers. Detection-layer concept only (main process); the renderer sees the broader
 * SessionStatus, which also includes `working` (inferred from user input, not a hook marker).
 */
export const ATTENTION_KINDS = ['idle', 'permission'] as const
export type AttentionKind = (typeof ATTENTION_KINDS)[number]

// The app-private tokens carried inside the OSC 9 sequence Claude Code prints via an injected
// Notification hook. notifSettings builds the sequence from these; the detector never scans for a
// bare token (that would false-trigger on file content or grep output) - only for the full sequence.
export const IDLE_TOKEN = 'INTERSECT_IDLE'
export const PERMISSION_TOKEN = 'INTERSECT_PERMISSION'

const ESC = '\x1b'
const BEL = '\x07'

/**
 * The exact bytes Claude emits and the detector matches: a full OSC 9 desktop-notification sequence
 * (ESC ] 9 ; <token> BEL) wrapping the app-private token. Requiring the wrapper is what keeps the
 * signal unambiguous - the token appearing as plain text in terminal output never matches.
 */
export const IDLE_MARKER = `${ESC}]9;${IDLE_TOKEN}${BEL}`
export const PERMISSION_MARKER = `${ESC}]9;${PERMISSION_TOKEN}${BEL}`

/** Marker-to-kind lookup, ordered most-urgent first so callers can scan permission before idle. */
export const MARKER_KINDS: readonly [string, AttentionKind][] = [
  [PERMISSION_MARKER, 'permission'],
  [IDLE_MARKER, 'idle']
]

/** Length of the longest marker, i.e. how much trailing context a detector must retain per session. */
export const MAX_MARKER_LEN = Math.max(IDLE_MARKER.length, PERMISSION_MARKER.length)
