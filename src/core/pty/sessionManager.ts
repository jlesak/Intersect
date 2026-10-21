import { existsSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import type { Preset } from '@common/domain'
import type { TerminalDataEvent, TerminalExitEvent } from '@common/ipc'
import { buildSpawn, type SpawnSpec } from './shell'

/** The minimal PTY surface the manager depends on (node-pty's IPty satisfies it). */
export interface PtyProcess {
  readonly pid: number
  onData(cb: (data: string) => void): void
  /** node-pty reports the signal alongside the code when one ended the child. */
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  pause(): void
  resume(): void
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
  /**
   * Defaults to buildSpawn; injected so tests stay independent of shell resolution. `cwd` is the
   * folder the tab asked for, even when it is missing and the PTY falls back to the home folder,
   * so a decoration keyed on the folder (fix worktrees) cannot be bypassed by deleting it.
   */
  buildSpec?: (
    preset: Preset,
    resumeSessionId: string | null | undefined,
    sessionId: string,
    cwd: string
  ) => SpawnSpec
  fileExists?: (path: string) => boolean
  homedir?: () => string
}

export interface SessionManager {
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
  killWorkspace(workspaceId: string): void
  killAll(): void
  /**
   * Resolve once every PTY of the workspace has really exited, `kill()`ed ones included, or with
   * 'timeout' after `timeoutMs`. A kill only signals the process; whoever deletes files the
   * session may still be writing waits here first. Resolves at once when none is running.
   */
  whenWorkspaceExited(workspaceId: string, timeoutMs: number): Promise<'exited' | 'timeout'>
}

/**
 * Owns the live PTY sessions keyed by `${workspaceId}:${tabId}`. Every method that takes a
 * sessionId no-ops on an unknown id (late events after teardown must never throw). Sessions
 * self-remove on pty exit (covers the user typing `exit`), and killWorkspace/killAll cover
 * workspace deletion and app quit so no shell is ever orphaned.
 */
export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const sessions = new Map<string, PtyProcess>()
  const starting = new Set<string>()
  // One entry per spawned process until its exit fires, killed or not. Keyed by the process, not
  // the session id: a respawn under the same id must not be mistaken for the old one having exited.
  const exits = new Map<PtyProcess, { sessionId: string; exited: Promise<void> }>()
  const buildSpec =
    deps.buildSpec ??
    ((preset: Preset, resumeSessionId: string | null | undefined, sessionId: string) =>
      buildSpawn(preset, { resumeSessionId, instanceId: sessionId }))
  const fileExists = deps.fileExists ?? existsSync
  const homedir = deps.homedir ?? osHomedir

  function spawn(
    sessionId: string,
    preset: Preset,
    cwd: string,
    cols: number,
    rows: number,
    resumeSessionId?: string | null
  ) {
    if (sessions.has(sessionId) || starting.has(sessionId)) return { ok: true }
    starting.add(sessionId)
    try {
      let effectiveCwd = cwd
      let notice: string | null = null
      if (!fileExists(cwd)) {
        effectiveCwd = homedir()
        notice = `\r\n[intersect] "${cwd}" not found - started in ${effectiveCwd}\r\n`
      }

      const spec = buildSpec(preset, resumeSessionId, sessionId, cwd)
      const proc = deps.spawn({
        file: spec.file,
        args: spec.args,
        cwd: effectiveCwd,
        cols,
        rows,
        env: spec.env
      })
      sessions.set(sessionId, proc)
      let markExited = (): void => {}
      const exited = new Promise<void>((resolve) => (markExited = resolve))
      exits.set(proc, { sessionId, exited })

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
        exits.delete(proc)
        markExited()
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
      sessions.get(sessionId)?.pause()
    },
    resume(sessionId) {
      sessions.get(sessionId)?.resume()
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
    },
    async whenWorkspaceExited(workspaceId, timeoutMs) {
      const prefix = `${workspaceId}:`
      const pending = [...exits.values()]
        .filter((e) => e.sessionId.startsWith(prefix))
        .map((e) => e.exited)
      if (pending.length === 0) return 'exited'
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
      })
      try {
        return await Promise.race([Promise.all(pending).then(() => 'exited' as const), timeout])
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
