import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveShell } from './pty/shell'

const execFileAsync = promisify(execFile)

/**
 * Make CLI tools installed under Homebrew, nvm, or ~/.local/bin resolvable from subprocesses the
 * app spawns directly (notably the Azure DevOps MCP server, launched as `npx ...`). When the app is
 * started from Finder/Dock rather than a terminal, macOS gives it the bare `/usr/bin:/bin` PATH, so
 * a plain `spawn('npx')` fails with ENOENT. The PTY sidesteps this by running a login shell; this
 * brings the same login-shell PATH to the non-PTY spawns by folding it into `process.env.PATH`.
 */

const PATH_DELIMITER = '__INTERSECT_PATH__'

type ShellRunner = (shell: string, args: string[]) => Promise<string>

/**
 * Extract the PATH a login shell printed between our delimiters. Delimiting the value lets us
 * ignore any banner or prompt text a dotfile writes to stdout around it.
 */
export function extractShellPath(output: string): string | null {
  const parts = output.split(PATH_DELIMITER)
  if (parts.length < 3) return null
  const path = parts[1].trim()
  return path || null
}

/**
 * Fold the login-shell PATH into the current PATH: login-shell dirs first (so a Homebrew/nvm tool
 * wins over a system one of the same name), then whatever was already there, with empties dropped
 * and duplicates removed. A null login PATH (resolution failed) leaves the current PATH unchanged.
 */
export function mergePath(current: string | undefined, loginPath: string | null): string | undefined {
  if (loginPath === null) return current
  const ordered = [...loginPath.split(':'), ...(current ?? '').split(':')].filter(Boolean)
  const deduped = [...new Set(ordered)]
  return deduped.join(':')
}

/**
 * The PATH exported by the user's login+interactive shell, or null on any failure (or on Windows,
 * where the GUI PATH already carries the usual install locations). Best-effort with a short timeout
 * so a slow or wedged shell profile can never block startup. Runs the shell asynchronously so the
 * main thread is never held while a heavy dotfile is sourced.
 */
export async function resolveLoginShellPath(opts: { shell?: string; run?: ShellRunner } = {}): Promise<string | null> {
  if (process.platform === 'win32') return null
  const shell = opts.shell ?? resolveShell()
  const run =
    opts.run ?? (async (s, args) => (await execFileAsync(s, args, { encoding: 'utf8', timeout: 5000 })).stdout)
  try {
    // ${PATH} is braced so the shell reads the PATH variable and not one named PATH + the
    // delimiter's leading underscores (which are valid in an identifier and would expand to empty).
    const output = await run(shell, ['-ilc', `printf '%s' "${PATH_DELIMITER}\${PATH}${PATH_DELIMITER}"`])
    return extractShellPath(output)
  } catch {
    return null
  }
}

let applied: Promise<void> | null = null

/**
 * Resolve the login-shell PATH once and merge it into `process.env.PATH` so every subprocess the
 * app spawns afterwards inherits it. The resolution runs off the main thread; kick it off at
 * startup without awaiting so window paint is never blocked, and await the returned promise from
 * any non-PTY spawn site that needs the merged PATH. Memoized so the shell is launched at most once.
 */
export function applyLoginShellPath(): Promise<void> {
  if (!applied) {
    applied = resolveLoginShellPath().then((loginPath) => {
      process.env.PATH = mergePath(process.env.PATH, loginPath)
    })
  }
  return applied
}
