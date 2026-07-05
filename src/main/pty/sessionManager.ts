import { existsSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import type { Preset } from '@common/domain'
import type { TerminalDataEvent, TerminalExitEvent } from '@common/ipc'
import { buildSpawn, type SpawnSpec } from './shell'

/** The minimal PTY surface the manager depends on (node-pty's IPty satisfies it). */
export interface PtyProcess {
  readonly pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface SpawnRequest {
  file: string
  args: string[]
  cwd: string
  cols: number
  rows: number
  env: Record<string, string>
}

export type SpawnFn = (req: SpawnRequest) => PtyProcess

export interface SessionManagerDeps {
  spawn: SpawnFn
  send: {
    data(event: TerminalDataEvent): void
    exit(event: TerminalExitEvent): void
  }
  /** Defaults to buildSpawn; injected so tests stay independent of shell resolution. */
  buildSpec?: (preset: Preset) => SpawnSpec
  fileExists?: (path: string) => boolean
  homedir?: () => string
}

export interface SessionManager {
  spawn(sessionId: string, preset: Preset, cwd: string, cols: number, rows: number): { ok: boolean }
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  pause(sessionId: string): void
  resume(sessionId: string): void
  kill(sessionId: string): void
  killWorkspace(workspaceId: string): void
  killAll(): void
}

// XON/XOFF flow-control bytes (node-pty intercepts these when handleFlowControl is on).
const XOFF = '\x13'
const XON = '\x11'

/**
 * Owns the live PTY sessions keyed by `${workspaceId}:${tabId}`. Every method that takes a
 * sessionId no-ops on an unknown id (late events after teardown must never throw). Sessions
 * self-remove on pty exit (covers the user typing `exit`), and killWorkspace/killAll cover
 * workspace deletion and app quit so no shell is ever orphaned.
 */
export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const sessions = new Map<string, PtyProcess>()
  const starting = new Set<string>()
  const buildSpec = deps.buildSpec ?? ((preset: Preset) => buildSpawn(preset))
  const fileExists = deps.fileExists ?? existsSync
  const homedir = deps.homedir ?? osHomedir

  function spawn(sessionId: string, preset: Preset, cwd: string, cols: number, rows: number) {
    if (sessions.has(sessionId) || starting.has(sessionId)) return { ok: true }
    starting.add(sessionId)
    try {
      let effectiveCwd = cwd
      let notice: string | null = null
      if (!fileExists(cwd)) {
        effectiveCwd = homedir()
        notice = `\r\n[jarvis] "${cwd}" not found - started in ${effectiveCwd}\r\n`
      }

      const spec = buildSpec(preset)
      const proc = deps.spawn({
        file: spec.file,
        args: spec.args,
        cwd: effectiveCwd,
        cols,
        rows,
        env: spec.env
      })
      sessions.set(sessionId, proc)

      if (notice) deps.send.data({ sessionId, data: notice })

      let initialWritten = false
      proc.onData((data) => {
        deps.send.data({ sessionId, data })
        if (spec.initialCommand && !initialWritten) {
          initialWritten = true
          proc.write(`${spec.initialCommand}\r`)
        }
      })
      proc.onExit(({ exitCode }) => {
        sessions.delete(sessionId)
        deps.send.exit({ sessionId, exitCode })
      })

      return { ok: true }
    } finally {
      starting.delete(sessionId)
    }
  }

  function kill(sessionId: string) {
    const proc = sessions.get(sessionId)
    if (!proc) return
    sessions.delete(sessionId)
    proc.kill()
  }

  return {
    spawn,
    write(sessionId, data) {
      sessions.get(sessionId)?.write(data)
    },
    resize(sessionId, cols, rows) {
      sessions.get(sessionId)?.resize(cols, rows)
    },
    pause(sessionId) {
      sessions.get(sessionId)?.write(XOFF)
    },
    resume(sessionId) {
      sessions.get(sessionId)?.write(XON)
    },
    kill,
    killWorkspace(workspaceId) {
      const prefix = `${workspaceId}:`
      for (const id of [...sessions.keys()]) {
        if (id.startsWith(prefix)) kill(id)
      }
    },
    killAll() {
      for (const id of [...sessions.keys()]) kill(id)
    }
  }
}
