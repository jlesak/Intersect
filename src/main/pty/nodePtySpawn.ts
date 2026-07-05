import { chmodSync, existsSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import * as pty from 'node-pty'
import type { PtyProcess, SpawnFn, SpawnRequest } from './sessionManager'

// XON/XOFF bytes matched to sessionManager.pause/resume. With handleFlowControl on, node-pty
// intercepts these writes and pauses/resumes the child process at the source (backpressure).
const XOFF = '\x13'
const XON = '\x11'

/** The one place node-pty is imported. Adapts its IPty to the PtyProcess the manager expects. */
export const nodePtySpawn: SpawnFn = (req: SpawnRequest): PtyProcess => {
  const proc = pty.spawn(req.file, req.args, {
    name: 'xterm-256color',
    cwd: req.cwd,
    cols: req.cols,
    rows: req.rows,
    env: req.env,
    handleFlowControl: true,
    flowControlPause: XOFF,
    flowControlResume: XON
  })
  return {
    pid: proc.pid,
    onData: (cb) => {
      proc.onData(cb)
    },
    onExit: (cb) => {
      proc.onExit(({ exitCode }) => cb({ exitCode }))
    },
    write: (data) => proc.write(data),
    resize: (cols, rows) => proc.resize(cols, rows),
    kill: () => proc.kill()
  }
}

function spawnHelperPath(): string | null {
  if (process.platform === 'win32') return null
  try {
    const entry = require.resolve('node-pty')
    const marker = `${sep}node-pty${sep}`
    const idx = entry.lastIndexOf(marker)
    if (idx === -1) return null
    const pkgDir = entry.slice(0, idx + marker.length - 1)
    return join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  } catch {
    return null
  }
}

/**
 * node-pty's prebuilt `spawn-helper` sometimes arrives without its execute bit after a clean
 * npm install, which makes posix_spawnp fail. Restore it at startup (best-effort, idempotent).
 */
export function ensureSpawnHelperExecutable(): void {
  const helper = spawnHelperPath()
  if (!helper || !existsSync(helper)) return
  try {
    const mode = statSync(helper).mode
    if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o755)
  } catch {
    // best-effort; spawn will surface a clear error if it truly cannot execute
  }
}
