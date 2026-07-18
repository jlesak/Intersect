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
  /**
   * A Claude Code session UUID to resume. When set, the claude preset launches
   * `claude --resume <id> ...` so the tab reopens that past conversation. Ignored by the shell preset.
   */
  resumeSessionId?: string | null
  /**
   * The stable Intersect session id (`workspaceId:tabId`) injected as INTERSECT_INSTANCE_ID
   * into the claude preset's environment, so the hook helper can tag every lifecycle event
   * with the session it belongs to. Ignored by the shell preset - only a managed claude
   * session may carry an instance identity.
   */
  instanceId?: string
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
    // Never inherit a stale instance identity; buildSpawn re-injects the right one below.
    if (key === 'INTERSECT_INSTANCE_ID') continue
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

  const env = sanitizeEnv(opts.env ?? process.env)
  if (preset === 'claude' && opts.instanceId) env.INTERSECT_INSTANCE_ID = opts.instanceId

  return {
    file,
    args,
    initialCommand: resolveInitialCommand(preset, opts.notifSettingsPath, opts.resumeSessionId),
    env
  }
}

/**
 * The command typed into the ready shell. For claude, appends `--resume <id>` when resuming a past
 * session and the app-managed `--settings` file (both single-quoted, since ids are safe but the
 * userData path contains spaces) so Claude emits Intersect's attention markers alongside the user's
 * own hooks. The command is prefixed with `stty -ixon;` to turn off the shell's own Ctrl+S/Ctrl+Q
 * flow control, so Ctrl+S reaches Claude Code (which reads it in raw mode) instead of being
 * swallowed by the kernel line discipline at the plain shell prompt before/after claude runs.
 */
function resolveInitialCommand(
  preset: Preset,
  notifSettingsPath?: string,
  resumeSessionId?: string | null
): string | null {
  const base = PRESET_META[preset].initialCommand
  if (base === null) return null
  if (preset !== 'claude') return base
  let command = `stty -ixon; ${base}`
  // The resume id is a Claude session UUID (a `.jsonl` basename). It is already single-quoted below,
  // but since it becomes part of a command typed into a live shell, we additionally require it to be
  // a bare token; anything else is not a real session id and is dropped rather than interpolated.
  if (resumeSessionId && SESSION_ID_PATTERN.test(resumeSessionId)) {
    command += ` --resume ${singleQuote(resumeSessionId)}`
  }
  if (notifSettingsPath) command += ` --settings ${singleQuote(notifSettingsPath)}`
  return command
}

/** A Claude session id is a filename-safe token (UUIDs in practice); nothing else can resume. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

/** POSIX single-quote a shell argument, safe for paths containing spaces or apostrophes. */
function singleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
