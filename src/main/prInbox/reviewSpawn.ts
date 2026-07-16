/**
 * Pure builder for the interactive Claude Code session used to review a pull request. Reviews use
 * the same login-shell launch as ordinary Claude Sessions so the shell resolves the user's Claude
 * version and Claude loads its normal user, project and local configuration. The only extra runtime
 * input is Intersect's local draft MCP server plus review guidance.
 */
import { buildSpawn } from '../pty/shell'

export const REVIEW_SYSTEM_PROMPT =
  'Record every finding intended for the pull request with the record_draft_comment tool, one call ' +
  'per finding, so it remains a local draft for human approval. Never publish review findings or ' +
  'comments yourself. Prose in your replies is not captured as a draft.'

export interface ReviewSpawnOptions {
  worktreePath: string
  mcpConfigPath: string
  prompt: string
  /** Deterministic override for tests; production resolves $SHELL. */
  shell?: string
  /** Environment to sanitize and pass to the login shell; defaults to process.env. */
  env?: Record<string, string | undefined>
}

export interface SpawnSpec {
  file: string
  args: string[]
  cwd: string
  /** Typed exactly once after the login shell first emits output. */
  initialCommand: string
  env: Record<string, string>
}

const REVIEW_PROMPT_ENV = 'INTERSECT_REVIEW_PROMPT'
const REVIEW_MCP_CONFIG_ENV = 'INTERSECT_REVIEW_MCP_CONFIG'
const REVIEW_SYSTEM_PROMPT_ENV = 'INTERSECT_REVIEW_SYSTEM_PROMPT'

function assertEnvironmentValue(name: string, value: string): void {
  if (value.includes('\0')) throw new Error(`${name} cannot contain NUL.`)
}

export function buildReviewSpawnSpec(opts: ReviewSpawnOptions): SpawnSpec {
  const shellSpec = buildSpawn('claude', { shell: opts.shell, env: opts.env })
  if (!shellSpec.initialCommand) {
    throw new Error('Claude shell spawn did not provide an initial command.')
  }

  assertEnvironmentValue('Review prompt', opts.prompt)
  assertEnvironmentValue('Review MCP config path', opts.mcpConfigPath)

  const initialCommand =
    `${shellSpec.initialCommand} --mcp-config "$${REVIEW_MCP_CONFIG_ENV}" ` +
    `--append-system-prompt "$${REVIEW_SYSTEM_PROMPT_ENV}" -- "$${REVIEW_PROMPT_ENV}"`

  return {
    file: shellSpec.file,
    args: shellSpec.args,
    cwd: opts.worktreePath,
    initialCommand,
    env: {
      ...shellSpec.env,
      [REVIEW_MCP_CONFIG_ENV]: opts.mcpConfigPath,
      [REVIEW_SYSTEM_PROMPT_ENV]: REVIEW_SYSTEM_PROMPT,
      [REVIEW_PROMPT_ENV]: opts.prompt
    }
  }
}
