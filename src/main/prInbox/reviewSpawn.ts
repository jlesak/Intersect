/**
 * Pure builder for the guardrailed `claude` spawn spec used by the AI review session. Kept free of
 * Electron / node-pty so the guardrail can be asserted in a unit test without spawning anything.
 *
 * The guarantee that the session cannot publish to Azure DevOps rests on, in order:
 *  1. `--strict-mcp-config` + a config that contains ONLY the local intersectReview draft server, so
 *     no Azure DevOps tool exists in the session at all.
 *  2. a closed `--allowed-tools` allowlist plus `--permission-mode dontAsk` (anything not allowed is
 *     denied without prompting).
 *  3. `--setting-sources` pinned so ambient user/project settings cannot widen the allowlist.
 *  4. an appended read-only/draft-only system prompt (guidance only, not the enforcement).
 */

/** The only tools the review session may use: read the worktree + record drafts. */
export const REVIEW_ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'mcp__intersectReview__record_draft_comment'
]

/**
 * Hard denials. The closed allowlist under `dontAsk` already blocks these, but denying them
 * explicitly is a version-independent second layer: `--disallowed-tools` overrides even an ambient
 * allow rule. Includes every tool that could reach the network or spawn work (egress paths) so a
 * prompt-injected session cannot exfiltrate what it reads, in addition to write/shell tools.
 */
export const REVIEW_DISALLOWED_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task'
]

/**
 * Read paths denied to the review session so it cannot pull secrets into model context. Reads are
 * otherwise unscoped under `dontAsk`; this closes the obvious credential files (deny beats allow).
 * Defense in depth alongside stripping secrets from the spawn env - not a full sandbox.
 */
export const REVIEW_DENY_READ_GLOBS = [
  'Read(//**/.claude.json)',
  'Read(//**/.claude/**)',
  'Read(//**/.ssh/**)',
  'Read(//**/.aws/**)',
  'Read(//**/.gnupg/**)',
  'Read(//**/.netrc)',
  'Read(//**/.config/**)',
  'Read(//**/.npmrc)',
  'Read(//etc/**)'
]

export const REVIEW_SYSTEM_PROMPT =
  'You are performing a READ-ONLY pull request review of the code checked out in this worktree. ' +
  'Read the changed files (see REVIEW_CONTEXT.md for the PR summary and the list of changed files). ' +
  'You must NOT attempt to publish, post, edit, comment on, or otherwise modify anything in Azure ' +
  'DevOps or on disk. To leave a review comment, call the record_draft_comment tool - one call per ' +
  'comment, anchored to a file path and a line on the RIGHT (new) side of the diff. Your comments ' +
  'reach the human only through that tool; prose in your replies is not captured.'

export interface ReviewSpawnOptions {
  claudePath: string
  worktreePath: string
  mcpConfigPath: string
  prompt: string
  /**
   * Which of user/project/local settings to load. Empty string loads NONE - the default - so
   * ambient `permissions.allow` rules cannot widen the session.
   */
  settingSources?: string
}

export interface SpawnSpec {
  file: string
  args: string[]
  cwd: string
}

export function buildReviewSpawnSpec(opts: ReviewSpawnOptions): SpawnSpec {
  const settings = JSON.stringify({ permissions: { deny: REVIEW_DENY_READ_GLOBS } })
  return {
    file: opts.claudePath,
    cwd: opts.worktreePath,
    args: [
      '--mcp-config',
      opts.mcpConfigPath,
      '--strict-mcp-config',
      '--setting-sources',
      opts.settingSources ?? '',
      '--settings',
      settings,
      '--allowed-tools',
      REVIEW_ALLOWED_TOOLS.join(' '),
      '--disallowed-tools',
      REVIEW_DISALLOWED_TOOLS.join(' '),
      '--permission-mode',
      'dontAsk',
      '--append-system-prompt',
      REVIEW_SYSTEM_PROMPT,
      opts.prompt
    ]
  }
}
