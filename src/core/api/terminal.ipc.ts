import type { Preset } from '@common/domain'
import { type WireRoutes } from '@common/coreBridge'
import { Channel } from '@common/ipc'
import type { SessionManager } from '../pty/sessionManager'

/** Service-side terminal surface: the request/response + fire-and-forget methods (no events). */
export interface TerminalHandlers {
  spawn(
    sessionId: string,
    preset: Preset,
    cwd: string,
    cols: number,
    rows: number,
    resumeSessionId?: string | null
  ): { ok: boolean }
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  pause(sessionId: string): void
  resume(sessionId: string): void
  kill(sessionId: string): void
}

export function createTerminalHandlers(sessions: SessionManager): TerminalHandlers {
  return {
    spawn: (id, preset, cwd, cols, rows, resumeSessionId) =>
      sessions.spawn(id, preset, cwd, cols, rows, resumeSessionId),
    write: (id, data) => sessions.write(id, data),
    resize: (id, cols, rows) => sessions.resize(id, cols, rows),
    pause: (id) => sessions.pause(id),
    resume: (id) => sessions.resume(id),
    kill: (id) => sessions.kill(id)
  }
}

/**
 * The slice's wire contract. `spawn` is the only correlated request; the rest arrive as
 * fire-and-forget notifications on the PTY fast path, including the active-session report
 * that feeds the attention notifier.
 */
export function terminalWireRoutes(
  h: TerminalHandlers,
  reportActive: (sessionId: string | null) => void
): WireRoutes {
  return {
    [Channel.terminalSpawn]: h.spawn,
    [Channel.terminalInput]: h.write,
    [Channel.terminalResize]: h.resize,
    [Channel.terminalPause]: h.pause,
    [Channel.terminalResume]: h.resume,
    [Channel.terminalKill]: h.kill,
    [Channel.terminalReportActive]: reportActive
  }
}
