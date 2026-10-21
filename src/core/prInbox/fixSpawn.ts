/**
 * The launch of a Claude tab that fixes my pull request's review comments. It is an ordinary
 * terminal tab, spawned by the session manager at the pane's real size, so lifecycle, attention
 * and snapshot tracking work as for any other tab. What differs is decided by the folder alone:
 * every Claude start whose requested folder is a fix worktree, a resume after a restart included,
 *
 * - scrubs secrets exactly as a PR review does, because the session reads text written by others;
 * - runs with `--permission-mode default`, so the user's own settings cannot turn on a bypass here;
 * - and, on the first start only, receives the parked comment list as its first message.
 *
 * There is no `--model`: the user's default model applies.
 */
import type { Preset } from '@common/domain'
import type { SpawnSpec } from '../pty/shell'
import { assertEnvironmentValue, scrubSecrets } from './reviewSpawn'

/** Carries the first message; not credential-shaped, so neither scrub layer removes it. */
export const FIX_PROMPT_ENV = 'INTERSECT_FIX_PROMPT'

/** Decorate a Claude tab's spawn spec for a fix worktree, with the first message when given. */
export function buildFixSpawnSpec(base: SpawnSpec, prompt: string | null): SpawnSpec {
  if (!base.initialCommand) {
    throw new Error('Claude shell spawn did not provide an initial command.')
  }
  if (prompt !== null) assertEnvironmentValue('Fix prompt', prompt)

  const command =
    `${base.initialCommand} --permission-mode default` +
    (prompt !== null ? ` -- "$${FIX_PROMPT_ENV}"` : '')
  const scrubbed = scrubSecrets({ file: base.file, env: base.env, initialCommand: command })

  return {
    file: base.file,
    args: base.args,
    initialCommand: scrubbed.initialCommand,
    env: prompt !== null ? { ...scrubbed.env, [FIX_PROMPT_ENV]: prompt } : scrubbed.env
  }
}

export interface DecorateTerminalOptions {
  preset: Preset
  /** The folder the tab asked for, not the home fallback used when that folder is missing. */
  cwd: string
  isFixFolder: (cwd: string) => boolean
  /** The parked first message for this folder, handed out once. */
  takePrompt: (cwd: string) => string | null
}

/**
 * The session manager's hook: a Claude tab in a fix worktree gets the fix launch, everything else
 * keeps its spec untouched. Keyed on the requested folder rather than on a parked prompt, so a tab
 * resumed after a restart, which has no prompt, is still held to the same rules.
 */
export function decorateTerminalSpec(base: SpawnSpec, opts: DecorateTerminalOptions): SpawnSpec {
  if (opts.preset !== 'claude' || !opts.isFixFolder(opts.cwd)) return base
  return buildFixSpawnSpec(base, opts.takePrompt(opts.cwd))
}
