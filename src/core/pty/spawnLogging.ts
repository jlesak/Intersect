import type { Logger } from '@common/logging/logger'
import type { PtyProcess, SpawnFn } from './sessionManager'

/**
 * Record the start and the end of every child the core forks through the PTY seam: terminal
 * sessions, the PR-review session, the hidden Jira fetch and the 1:1 run all come through here.
 *
 * A PTY exit reaches the renderer as a push, which writes nothing to the file, so without this a
 * terminal that dies leaves no trace at all in the app's primary subsystem. Applied where `spawn`
 * is injected, so no call site changes and no child can be started around it.
 *
 * The listener registered here is one of several on the same event; it observes the exit and
 * changes nothing about it.
 */
export function withPtySpawnLogging(spawn: SpawnFn, logger: Logger): SpawnFn {
  return (req): PtyProcess => {
    const proc = spawn(req)
    const data = { command: req.file, pid: proc.pid }
    logger.info('child process spawned', { data })
    proc.onExit(({ exitCode, signal }) => {
      const outcome = { ...data, exitCode, signal }
      // A shell the user closed is ordinary; anything else ended the child against its will, which
      // is what a reader is looking for when a session disappeared on its own.
      if (exitCode === 0) logger.info('child process exited', { data: outcome })
      else logger.warn('child process exited', { data: outcome })
    })
    return proc
  }
}
