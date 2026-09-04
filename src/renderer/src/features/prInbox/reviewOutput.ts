/**
 * The PTY output of every live review session, held outside the store.
 *
 * Review output arrives in small chunks many times a second. Putting it in the zustand store made
 * every chunk notify every PR Inbox selector, and with several reviews running at once that is a
 * board-wide re-render per keystroke of Claude's output. It is also unbounded: a long review would
 * grow one string forever. So the bytes live here, in a module-level map with its own listeners,
 * and the store keeps only which session belongs to which pull request.
 *
 * Each buffer keeps the tail of the stream. `written` is the monotonic total of characters ever
 * appended, never the buffer length, so a terminal that mounts after the buffer was trimmed can
 * still tell what it has already rendered - a length-based cursor would rewind on every trim and
 * replay the whole tail again.
 *
 * A trim cuts the stream wherever the limit falls, which can be inside an escape sequence, and a
 * terminal mounted after that redraws one briefly garbled screen. Cutting on a line boundary would
 * not help: the colours and modes a terminal was left in were set by sequences the trim discarded
 * either way, so the only real fix is to replay from the start - which is the unbounded buffer this
 * limit exists to prevent. It costs one imperfect repaint per megabyte of review output.
 */

/** Characters kept per session. xterm's own scrollback is 5000 lines, well inside this. */
export const MAX_BUFFERED_CHARS = 1_000_000

interface Buffer {
  text: string
  written: number
  listeners: Set<(text: string, written: number) => void>
}

const buffers = new Map<string, Buffer>()

function bufferFor(sessionId: string): Buffer {
  let buffer = buffers.get(sessionId)
  if (!buffer) {
    buffer = { text: '', written: 0, listeners: new Set() }
    buffers.set(sessionId, buffer)
  }
  return buffer
}

/** Append one PTY chunk and hand it to whatever terminal is mounted for that session. */
export function appendReviewOutput(sessionId: string, data: string): void {
  const buffer = bufferFor(sessionId)
  buffer.text += data
  buffer.written += data.length
  if (buffer.text.length > MAX_BUFFERED_CHARS) {
    buffer.text = buffer.text.slice(buffer.text.length - MAX_BUFFERED_CHARS)
  }
  for (const listener of buffer.listeners) listener(data, buffer.written)
}

/** The buffered tail plus the cursor it ends at, for a terminal that has just mounted. */
export function readReviewOutput(sessionId: string): { text: string; written: number } {
  const buffer = bufferFor(sessionId)
  return { text: buffer.text, written: buffer.written }
}

/** Subscribe to the chunks appended from now on. Returns the unsubscribe. */
export function onReviewOutput(
  sessionId: string,
  listener: (data: string, written: number) => void
): () => void {
  const buffer = bufferFor(sessionId)
  buffer.listeners.add(listener)
  return () => {
    buffer.listeners.delete(listener)
  }
}

/** Drop a finished session's buffer. Without this every review leaks its output for the app's life. */
export function dropReviewOutput(sessionId: string): void {
  buffers.delete(sessionId)
}

/** Test seam: forget every buffer. */
export function resetReviewOutput(): void {
  buffers.clear()
}
