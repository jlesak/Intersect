import { MARKER_KINDS, MAX_MARKER_LEN, type AttentionKind } from './attentionMarkers'

export interface AttentionDetector {
  /**
   * Feed a raw PTY output chunk for a session. Returns the detected kind, or null if none.
   * Detects a marker even when it is split across two consecutive chunks for the same session.
   * If both markers are present, 'permission' wins as the more urgent state.
   */
  push(sessionId: string, chunk: string): AttentionKind | null
  /** Drop a session's buffered tail (call on session exit) so it cannot leak into a future session. */
  forget(sessionId: string): void
}

const TAIL_LEN = MAX_MARKER_LEN - 1

/**
 * Stateful, per-session, split-chunk-safe scanner for the app-private attention markers.
 * Keeps only the last TAIL_LEN characters seen per session (O(1) memory) and prepends that
 * tail to each new chunk before scanning, so a marker straddling a chunk boundary is still found.
 */
export function createAttentionDetector(): AttentionDetector {
  const tails = new Map<string, string>()

  function push(sessionId: string, chunk: string): AttentionKind | null {
    const prevTail = tails.get(sessionId) ?? ''
    const haystack = prevTail + chunk
    tails.set(sessionId, haystack.slice(-TAIL_LEN))

    for (const [marker, kind] of MARKER_KINDS) {
      if (haystack.includes(marker)) return kind
    }
    return null
  }

  function forget(sessionId: string): void {
    tails.delete(sessionId)
  }

  return { push, forget }
}
