import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Run a git command inside a repo, returning stdout verbatim (no trimming). */
export async function gitRaw(repoDir: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await exec('git', ['-C', repoDir, ...args], {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  })
  return stdout
}

/**
 * Run a git command inside a repo. execFile (no shell) so branch names/paths can't inject. Trims
 * surrounding whitespace, which suits commands whose output is a single token (rev-parse, etc.); use
 * gitRaw when exact file content matters.
 */
export async function git(repoDir: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return (await gitRaw(repoDir, args, timeoutMs)).trim()
}

/** Retry a git op a few times when the repo's index/ref is transiently locked by the user's own git. */
export async function gitWithLockRetry(
  repoDir: string,
  args: string[],
  timeoutMs?: number
): Promise<string> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await git(repoDir, args, timeoutMs)
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      if (!/index\.lock|unable to create|another git process/i.test(msg)) throw err
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
    }
  }
  throw lastErr
}
