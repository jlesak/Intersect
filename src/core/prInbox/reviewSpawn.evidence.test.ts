import { test } from 'vitest'
import { writeFileSync } from 'node:fs'
import { buildReviewSpawnSpec } from './reviewSpawn'

// Not an assertion test: dumps the real launch spec so a reviewer can see the exact login-shell
// command, env, and secret scrub Intersect will run for a PR review. Writes to EVIDENCE_DIR.
test('dump review spawn spec for evidence', () => {
  const dir = process.env.EVIDENCE_DIR
  if (!dir) return

  const spec = buildReviewSpawnSpec({
    shell: '/bin/zsh',
    env: {
      SHELL: '/bin/zsh',
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/Users/dev',
      ANTHROPIC_API_KEY: 'sk-ant-KEPT-for-auth',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-KEPT-for-auth',
      AZURE_DEVOPS_EXT_PAT: 'STRIPPED-ado-pat',
      GITHUB_TOKEN: 'STRIPPED-gh-token',
      DB_PASSWORD: 'STRIPPED-db-password',
      ELECTRON_RUN_AS_NODE: '1'
    },
    worktreePath: '/Users/dev/.intersect/worktrees/pr-1234',
    mcpConfigPath: '/Users/dev/.intersect/worktrees/pr-1234/.intersect-review-mcp.json',
    prompt: "Review this PR in English.\n\nBe thorough. Handle O'Brien's $(edge) cases.\n"
  })

  const out = [
    '=== Intersect PR-review launch spec (Issue #33) ===',
    '',
    `file: ${spec.file}`,
    `args: ${JSON.stringify(spec.args)}   (login shell -l, same path as Sessions)`,
    `cwd:  ${spec.cwd}`,
    '',
    '--- initialCommand typed into the ready login shell ---',
    spec.initialCommand,
    '',
    '--- env passed to the PTY (secrets stripped, Claude auth + PATH kept) ---',
    ...Object.entries(spec.env).map(([k, v]) => `  ${k}=${v}`),
    '',
    '--- system prompt (via $INTERSECT_REVIEW_SYSTEM_PROMPT, human-approval channel) ---',
    spec.env.INTERSECT_REVIEW_SYSTEM_PROMPT,
    '',
    '--- user prompt (via $INTERSECT_REVIEW_PROMPT, preserved verbatim) ---',
    JSON.stringify(spec.env.INTERSECT_REVIEW_PROMPT)
  ].join('\n')

  writeFileSync(`${dir}/review-launch-spec.txt`, out)
})
