import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Filename (relative to userData) holding the bearer token hook posts authenticate with. */
export const HOOK_TOKEN_FILENAME = 'hook-token'
/** Filename (relative to userData) of the sidecar the helper reads the listener port from. */
export const LISTENER_SIDECAR_FILENAME = 'listener.json'

/**
 * The discovery file the hook helper reads on every invocation: where the listener is
 * actually bound this run. Written only after a successful bind, so a stale sidecar from a
 * previous run at worst points the helper at a dead port (which its timeout absorbs).
 */
export interface ListenerSidecar {
  port: number
  writtenAt: number
}

/**
 * The per-install bearer token the listener requires on every hook POST. Reused across
 * runs when present so already-generated settings files stay valid; created once with
 * owner-only permissions otherwise.
 */
export function readOrCreateToken(userDataDir: string): string {
  const file = join(userDataDir, HOOK_TOKEN_FILENAME)
  if (existsSync(file)) {
    return readFileSync(file, 'utf8').trim()
  }
  const token = randomBytes(32).toString('hex')
  writeFileSync(file, token, { mode: 0o600 })
  chmodSync(file, 0o600)
  return token
}

/**
 * Atomically publish the listener's bound port (tmp + rename, owner-only), so a helper
 * reading mid-write never sees a truncated file.
 */
export function writeListenerSidecar(file: string, data: ListenerSidecar): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
  chmodSync(file, 0o600)
}

/** The sidecar's contents, or null when absent/corrupt (the helper then just gives up). */
export function readListenerSidecar(file: string): ListenerSidecar | null {
  if (!existsSync(file)) return null
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<ListenerSidecar>
    if (typeof data.port !== 'number') return null
    return { port: data.port, writtenAt: Number(data.writtenAt) || 0 }
  } catch {
    return null
  }
}
