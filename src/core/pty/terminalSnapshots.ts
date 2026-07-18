import { Terminal, type ITerminalAddon } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'

// Caps how much history a reattaching renderer can recover, and with it the per-session
// memory the headless emulator may hold.
const SCROLLBACK_LINES = 200

interface SnapshotEntry {
  term: Terminal
  serializer: SerializeAddon
}

/**
 * One headless terminal emulator per live PTY session. Every PTY chunk is parsed into it so a
 * renderer that reattaches later can replay the current screen, colors, and recent scrollback
 * without respawning the process. The buffers live only in this process and never leave it
 * except over the core -> renderer port on an explicit attach.
 */
export interface TerminalSnapshots {
  /**
   * Start emulating a session at the PTY's real dimensions. A session already being emulated
   * is left untouched, and a failed emulator construction degrades the session to empty
   * attaches instead of breaking the terminal.
   */
  create(sessionId: string, cols: number, rows: number): void
  /** Parse one PTY chunk. Unknown sessions are ignored. */
  feed(sessionId: string, chunk: string): void
  /** Resolves once everything fed so far has been parsed - the attach ordering barrier. */
  flush(sessionId: string): Promise<void>
  /** Replayable ANSI for the current screen plus capped scrollback (SGR colors included). */
  serialize(sessionId: string): string
  resize(sessionId: string, cols: number, rows: number): void
  /** Drop the session's emulator and serializer. Safe to repeat. */
  dispose(sessionId: string): void
}

export function createTerminalSnapshots(): TerminalSnapshots {
  const entries = new Map<string, SnapshotEntry>()

  return {
    create(sessionId, cols, rows) {
      if (entries.has(sessionId)) return
      try {
        const term = new Terminal({
          cols: cols > 0 ? cols : 80,
          rows: rows > 0 ? rows : 24,
          scrollback: SCROLLBACK_LINES,
          allowProposedApi: true
        })
        const serializer = new SerializeAddon()
        // The serialize addon is typed against the browser xterm package; the headless
        // terminal exposes the identical addon surface.
        term.loadAddon(serializer as unknown as ITerminalAddon)
        entries.set(sessionId, { term, serializer })
      } catch (err) {
        console.warn(`[terminal] snapshot init failed for ${sessionId}:`, err)
      }
    },
    feed(sessionId, chunk) {
      entries.get(sessionId)?.term.write(chunk)
    },
    flush(sessionId) {
      const entry = entries.get(sessionId)
      if (!entry) return Promise.resolve()
      // An empty write's callback fires only after everything queued before it has parsed.
      return new Promise((resolve) => entry.term.write('', () => resolve()))
    },
    serialize(sessionId) {
      return entries.get(sessionId)?.serializer.serialize() ?? ''
    },
    resize(sessionId, cols, rows) {
      const entry = entries.get(sessionId)
      if (entry && cols > 0 && rows > 0) entry.term.resize(cols, rows)
    },
    dispose(sessionId) {
      const entry = entries.get(sessionId)
      if (!entry) return
      entries.delete(sessionId)
      entry.term.dispose()
    }
  }
}
