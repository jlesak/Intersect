import type { TerminalDataEvent } from '@common/ipc'

/**
 * Demultiplexes the single `terminal:data` broadcast to the correct terminal's sink by
 * sessionId. Pure and stateful-but-testable: one instance lives at module scope in the
 * terminal controller and is fed by exactly one IPC listener for the renderer's lifetime.
 */
export interface DataRouter {
  register(sessionId: string, sink: (data: string, seq?: number) => void): void
  route(event: TerminalDataEvent): void
  dispose(sessionId: string): void
}

export function createDataRouter(): DataRouter {
  const sinks = new Map<string, (data: string, seq?: number) => void>()
  return {
    register(sessionId, sink) {
      sinks.set(sessionId, sink)
    },
    route({ sessionId, data, seq }) {
      sinks.get(sessionId)?.(data, seq)
    },
    dispose(sessionId) {
      sinks.delete(sessionId)
    }
  }
}
