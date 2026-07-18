import {
  KIND_PRIORITY,
  MARKER_PREFIX,
  MARKER_TERMINATOR,
  TOKEN_KINDS,
  type AttentionKind
} from './attentionMarkers'

/** A detected marker: which state Claude signalled, and its own message when the hook carried one. */
export interface AttentionAlert {
  kind: AttentionKind
  /** Claude's own notification text, when present (Notification hooks carry one; Stop never does). */
  message?: string
}

export interface AttentionDetector {
  /**
   * Feed a raw PTY output chunk for a session. Returns the most urgent marker found, or null if
   * none. Detects a marker even when it - including a message payload of any length - is split
   * across any number of consecutive chunks for the same session. If multiple complete markers
   * land in the same chunk, 'permission' wins as the most urgent state.
   */
  push(sessionId: string, chunk: string): AttentionAlert | null
  /** Drop a session's buffered tail (call on session exit) so it cannot leak into a future session. */
  forget(sessionId: string): void
}

// An in-progress marker (an OSC 9 prefix seen but no terminating BEL yet) is buffered so a message
// payload split across many small chunks is still found - but capped, so a prefix that never
// terminates (never expected from a real hook, but not a crash-worthy condition either) cannot
// grow a session's buffered tail without bound.
const MAX_PENDING_LEN = 4096

/** A complete marker: the prefix, an all-caps token, an optional `;<base64 payload>`, the terminator. */
const MARKER_PATTERN = new RegExp(
  `${MARKER_PREFIX}([A-Z_]+)(?:;([A-Za-z0-9+/=]*))?${MARKER_TERMINATOR}`,
  'g'
)

/** Best-effort base64 decode. Node's decoder does not throw on malformed input, but this never lets a garbled payload surface as anything worse than "no message". */
function decodeMessage(base64?: string): string | undefined {
  if (!base64) return undefined
  try {
    const decoded = Buffer.from(base64, 'base64').toString('utf8')
    return decoded.length > 0 ? decoded : undefined
  } catch {
    return undefined
  }
}

/**
 * Stateful, per-session, split-chunk-safe scanner for the app-private attention markers. Buffers
 * only an in-progress marker (opened but not yet terminated by BEL) per session, so a marker - and
 * any message payload it carries - straddling any number of chunk boundaries is still found.
 */
export function createAttentionDetector(): AttentionDetector {
  const tails = new Map<string, string>()

  function push(sessionId: string, chunk: string): AttentionAlert | null {
    const prevTail = tails.get(sessionId) ?? ''
    const haystack = prevTail + chunk

    let best: AttentionAlert | null = null
    let bestPriority = -1
    let lastEnd = 0
    MARKER_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = MARKER_PATTERN.exec(haystack))) {
      lastEnd = match.index + match[0].length
      const kind = TOKEN_KINDS[match[1]]
      if (!kind) continue
      const priority = KIND_PRIORITY[kind]
      if (priority > bestPriority) {
        bestPriority = priority
        best = { kind, message: decodeMessage(match[2]) }
      }
    }

    // Keep only what could still become a marker: an unterminated prefix at the end of what's left
    // after the last complete match, or - failing that - just enough trailing characters to
    // possibly be the start of one (the prefix itself split across chunks).
    const remainder = haystack.slice(lastEnd)
    const prefixIndex = remainder.lastIndexOf(MARKER_PREFIX)
    const tail =
      prefixIndex === -1 ? remainder.slice(-(MARKER_PREFIX.length - 1)) : remainder.slice(prefixIndex)
    tails.set(sessionId, tail.length > MAX_PENDING_LEN ? '' : tail)

    return best
  }

  function forget(sessionId: string): void {
    tails.delete(sessionId)
  }

  return { push, forget }
}
