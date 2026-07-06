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
  /**
   * Absolute path to the app-managed Claude Code `--settings` file. When set, the claude preset
   * launches with it so Claude emits Intersect's attention markers, without touching the user's
   * own settings. Ignored by the plain shell preset.
   */
  notifSettingsPath?: string
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
    initialCommand: resolveInitialCommand(preset, opts.notifSettingsPath),
    env: sanitizeEnv(opts.env ?? process.env)
  }
}

/**
 * The command typed into the ready shell. For claude, appends the app-managed `--settings` file
 * (single-quoted, since the userData path contains spaces) so Claude emits Intersect's attention
 * markers alongside the user's own hooks.
 */
function resolveInitialCommand(preset: Preset, notifSettingsPath?: string): string | null {
  const base = PRESET_META[preset].initialCommand
  if (base === null) return null
  if (preset === 'claude' && notifSettingsPath) {
    return `${base} --settings ${singleQuote(notifSettingsPath)}`
  }
  return base
}

/** POSIX single-quote a shell argument, safe for paths containing spaces or apostrophes. */
function singleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
