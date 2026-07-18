import type { TerminalAttachResult, TerminalDataEvent } from '@common/ipc'
import type { TerminalSnapshots } from './terminalSnapshots'

interface SessionStream {
  /**
   * Monotonic per-chunk counter. Feeding the snapshot and emitting the push happen in the
   * same synchronous block as the increment, so the snapshot always contains exactly the
   * chunks with seq <= the lastSeq an attach reports.
   */
  seq: number
  cols: number
  rows: number
  /** Non-null while an attach holds the gate closed; chunks land here instead of the pipeline. */
  held: string[] | null
  /** Attaches for one session run strictly one after another so a later gate cannot clobber an earlier one's held chunks. */
  attachChain: Promise<void>
}

export interface TerminalStreamDeps {
  snapshots: TerminalSnapshots
  /** The complete downstream fanout for one data event (renderer push plus attention tap). */
  emit(event: TerminalDataEvent): void
  log?(message: string): void
}

/**
 * The ordered PTY data pipeline: every chunk is numbered, parsed into the session's headless
 * snapshot, and only then fanned out. `attach` runs the reattach protocol - close the gate,
 * flush the snapshot, capture `lastSeq`, serialize, reopen and replay - which guarantees the
 * snapshot and the subsequent pushes partition the stream exactly at `lastSeq`: nothing is
 * lost and nothing can render twice. The gate holds chunks only for the duration of one
 * snapshot flush (milliseconds) and replays them immediately, so it adds no unbounded queue;
 * the PTY watermark pause/resume remains the real backpressure.
 */
export interface TerminalStream {
  /** Track a session at its spawn dimensions. Returns false when it was already tracked. */
  onSpawn(sessionId: string, cols: number, rows: number): boolean
  onData(sessionId: string, data: string): void
  onResize(sessionId: string, cols: number, rows: number): void
  attach(sessionId: string): Promise<TerminalAttachResult>
  /** Stop tracking and drop the snapshot. Safe to repeat. */
  dispose(sessionId: string): void
  disposeAll(): void
}

export function createTerminalStream(deps: TerminalStreamDeps): TerminalStream {
  const streams = new Map<string, SessionStream>()
  const log = deps.log ?? (() => {})

  function push(st: SessionStream, sessionId: string, data: string): void {
    st.seq += 1
    deps.snapshots.feed(sessionId, data)
    deps.emit({ sessionId, data, seq: st.seq })
  }

  function onData(sessionId: string, data: string): void {
    const st = streams.get(sessionId)
    if (!st) {
      // A chunk racing session teardown: nothing tracks the counter anymore, but the
      // renderer may still want the bytes, so forward them without snapshot bookkeeping.
      deps.emit({ sessionId, data })
      return
    }
    if (st.held) {
      st.held.push(data)
      return
    }
    push(st, sessionId, data)
  }

  async function runAttach(sessionId: string): Promise<TerminalAttachResult> {
    const st = streams.get(sessionId)
    if (!st) return { live: false }
    const started = Date.now()
    // Close the gate. From here until it reopens nothing is parsed or pushed, so the flush
    // barrier below covers every numbered chunk and the serialized snapshot corresponds
    // exactly to seq <= lastSeq.
    st.held = []
    await deps.snapshots.flush(sessionId)
    if (streams.get(sessionId) !== st) return { live: false }
    const lastSeq = st.seq
    const data = deps.snapshots.serialize(sessionId)
    const held = st.held
    st.held = null
    for (const chunk of held) push(st, sessionId, chunk)
    log(
      `[terminal] attach ${sessionId}: ${data.length} bytes, ${held.length} chunks held, ${Date.now() - started}ms`
    )
    return { live: true, data, cols: st.cols, rows: st.rows, lastSeq }
  }

  return {
    onSpawn(sessionId, cols, rows) {
      if (streams.has(sessionId)) return false
      streams.set(sessionId, { seq: 0, cols, rows, held: null, attachChain: Promise.resolve() })
      deps.snapshots.create(sessionId, cols, rows)
      return true
    },
    onData,
    onResize(sessionId, cols, rows) {
      const st = streams.get(sessionId)
      if (!st || cols <= 0 || rows <= 0) return
      st.cols = cols
      st.rows = rows
      deps.snapshots.resize(sessionId, cols, rows)
    },
    attach(sessionId) {
      const st = streams.get(sessionId)
      if (!st) return Promise.resolve({ live: false })
      const run = st.attachChain.then(() => runAttach(sessionId))
      st.attachChain = run.then(
        () => undefined,
        () => undefined
      )
      return run
    },
    dispose(sessionId) {
      if (!streams.delete(sessionId)) return
      deps.snapshots.dispose(sessionId)
    },
    disposeAll() {
      for (const sessionId of [...streams.keys()]) {
        streams.delete(sessionId)
        deps.snapshots.dispose(sessionId)
      }
    }
  }
}
