import { chmodSync, existsSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

/**
 * The helper node-pty actually runs. In the packaged app node-pty resolves inside `app.asar`, but
 * a binary cannot run from an archive, so node-pty swaps in `app.asar.unpacked`
 * (unixTerminal.js). Mirror that swap, or the chmod lands on the archive's copy.
 */
function spawnHelperPath(nodePtyEntry: string): string | null {
  if (process.platform === 'win32') return null
  const marker = `${sep}node-pty${sep}`
  const idx = nodePtyEntry.lastIndexOf(marker)
  if (idx === -1) return null
  const pkgDir = nodePtyEntry
    .slice(0, idx + marker.length - 1)
    .replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
    .replace(`${sep}node_modules.asar${sep}`, `${sep}node_modules.asar.unpacked${sep}`)
  return join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
}

/**
 * node-pty's prebuilt `spawn-helper` arrives without its execute bit after a clean npm install,
 * which makes posix_spawnp fail. Restore it (best-effort, idempotent).
 */
export function makeSpawnHelperExecutable(nodePtyEntry: string): void {
  const helper = spawnHelperPath(nodePtyEntry)
  if (!helper || !existsSync(helper)) return
  try {
    const mode = statSync(helper).mode
    if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o755)
  } catch {
    // best-effort; spawn will surface a clear error if it truly cannot execute
  }
}
