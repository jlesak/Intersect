import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Keychain service name Claude Code stores its OAuth credentials under on macOS. */
export const KEYCHAIN_SERVICE = 'Claude Code-credentials'

/** Path Claude Code writes its credentials to where there is no Keychain (Linux, WSL). */
function credentialsFilePath(home: string): string {
  return join(home, '.claude', '.credentials.json')
}

/**
 * Picks the live OAuth access token out of Claude Code's raw credentials JSON, or null when there
 * is none to use: unreadable content, an unrecognized shape, or a token that has already expired.
 *
 * The same blob carries a `refreshToken`, which this app deliberately ignores. Renewing Claude
 * Code's credentials is Claude Code's own job, and racing it risks invalidating the token the
 * user's real sessions depend on. An expired token means no live usage query, nothing more.
 */
export function parseAccessToken(raw: string | null, now: number): string | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown }
    }
    const oauth = parsed?.claudeAiOauth
    if (typeof oauth?.accessToken !== 'string' || oauth.accessToken.length === 0) return null
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= now) return null
    return oauth.accessToken
  } catch {
    return null
  }
}

/** Runs `security find-generic-password`, resolving null on any failure (denied, absent, no tool). */
function readKeychain(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 5000 },
      (error, stdout) => resolve(error ? null : stdout.trim() || null)
    )
  })
}

/** Injected platform and I/O seam, so tests can exercise the fallback without a real Keychain. */
export interface CredentialsIo {
  platform: string
  home: string
  /** The Keychain entry's content, or null when there is none or access was denied. */
  readKeychain(): Promise<string | null>
  /** A UTF-8 file's content. Rejects when the file cannot be read. */
  readTextFile(path: string): Promise<string>
}

const defaultIo: CredentialsIo = {
  platform: process.platform,
  home: homedir(),
  readKeychain,
  readTextFile: (path) => readFile(path, 'utf8')
}

/**
 * Claude Code's raw credentials JSON, from the macOS Keychain where there is one and the
 * `~/.claude/.credentials.json` file otherwise (or when the Keychain read is denied). Resolves
 * null rather than throwing: no credentials just means the live usage query is unavailable.
 */
export async function readClaudeCredentials(io: Partial<CredentialsIo> = {}): Promise<string | null> {
  const { platform, home, readKeychain: keychain, readTextFile } = { ...defaultIo, ...io }
  if (platform === 'darwin') {
    const fromKeychain = await keychain().catch(() => null)
    if (fromKeychain) return fromKeychain
  }
  try {
    return await readTextFile(credentialsFilePath(home))
  } catch {
    return null
  }
}
