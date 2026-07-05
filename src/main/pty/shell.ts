import { PRESET_META, type Preset } from '@common/domain'

type EnvInput = Record<string, string | undefined>

export interface SpawnSpec {
  file: string
  args: string[]
  /** Written into the shell once it is ready (claude preset); null for a plain shell. */
  initialCommand: string | null
  env: Record<string, string>
}

export interface BuildSpawnOptions {
  /** Override the shell binary; defaults to $SHELL then /bin/zsh. */
  shell?: string
  /** E2E: spawn a no-rc shell so output does not depend on the user's dotfiles. */
  testMode?: boolean
  /** Environment to derive from; defaults to process.env. */
  env?: EnvInput
}

/** The user's default shell, falling back to zsh (macOS default). */
export function resolveShell(env: EnvInput = process.env): string {
  return env.SHELL || '/bin/zsh'
}

/**
 * Strip Electron's own env vars (they confuse node-based CLIs) and force a rich TERM. The
 * rest of the environment is passed through so the login shell can rebuild PATH from the
 * user's profile - which is how `claude` in ~/.local/bin becomes resolvable.
 */
function sanitizeEnv(env: EnvInput): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (key.startsWith('ELECTRON_')) continue
    out[key] = value
  }
  out.TERM = 'xterm-256color'
  return out
}

/**
 * Pure spec for launching a preset's PTY. No node-pty import, no filesystem - so it is fully
 * unit-testable. In normal mode both presets spawn a login+interactive shell (`-l`) so the
 * profile loads and PATH resolves; the claude preset additionally types `claude` once the
 * shell is ready. In test mode a no-rc shell keeps E2E output deterministic across machines.
 */
export function buildSpawn(preset: Preset, opts: BuildSpawnOptions = {}): SpawnSpec {
  const file = opts.shell ?? resolveShell(opts.env)
  const isBash = file.includes('bash')

  const args = opts.testMode ? (isBash ? ['--norc', '--noprofile', '-i'] : ['-f']) : ['-l']

  return {
    file,
    args,
    initialCommand: PRESET_META[preset].initialCommand,
    env: sanitizeEnv(opts.env ?? process.env)
  }
}
