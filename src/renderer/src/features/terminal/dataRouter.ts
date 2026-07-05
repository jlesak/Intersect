import type { TerminalDataEvent } from '@common/ipc'

/**
 * Demultiplexes the single `terminal:data` broadcast to the correct terminal's sink by
 * sessionId. Pure and stateful-but-testable: one instance lives at module scope in the
 * terminal controller and is fed by exactly one IPC listener for the renderer's lifetime.
 */
export interface DataRouter {
  register(sessionId: string, sink: (data: string) => void): void
  route(event: TerminalDataEvent): void
  dispose(sessionId: string): void
}

export function createDataRouter(): DataRouter {
  const sinks = new Map<string, (data: string) => void>()
  return {
    register(sessionId, sink) {
      sinks.set(sessionId, sink)
    },
    route({ sessionId, data }) {
      sinks.get(sessionId)?.(data)
    },
    dispose(sessionId) {
      sinks.delete(sessionId)
    }
  }
}
