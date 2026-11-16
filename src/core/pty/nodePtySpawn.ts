import * as pty from 'node-pty'
import type { PtyProcess, SpawnFn, SpawnRequest } from './sessionManager'
import { makeSpawnHelperExecutable } from './spawnHelper'

/** The one place node-pty is imported. Adapts its IPty to the PtyProcess the manager expects. */
export const nodePtySpawn: SpawnFn = (req: SpawnRequest): PtyProcess => {
  const proc = pty.spawn(req.file, req.args, {
    name: 'xterm-256color',
    cwd: req.cwd,
    cols: req.cols,
    rows: req.rows,
    env: req.env
  })
  return {
    pid: proc.pid,
    onData: (cb) => {
      proc.onData(cb)
    },
    onExit: (cb) => {
      proc.onExit(({ exitCode, signal }) => cb({ exitCode, signal }))
    },
    write: (data) => proc.write(data),
    resize: (cols, rows) => proc.resize(cols, rows),
    pause: () => proc.pause(),
    resume: () => proc.resume(),
    kill: () => proc.kill()
  }
}

/** Restore the execute bit on the spawn-helper this node-pty runs, before any spawn. */
export function ensureSpawnHelperExecutable(): void {
  let entry: string
  try {
    entry = require.resolve('node-pty')
  } catch {
    return
  }
  makeSpawnHelperExecutable(entry)
}
