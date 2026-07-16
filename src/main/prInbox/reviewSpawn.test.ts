import { describe, expect, test } from 'vitest'
import { buildReviewSpawnSpec } from './reviewSpawn'

const base = {
  shell: '/bin/zsh',
  env: {
    SHELL: '/bin/zsh',
    PATH: '/usr/bin',
    CLAUDE_PLUGIN_SETTING: 'ambient-value',
    ELECTRON_RUN_AS_NODE: '1'
  },
  worktreePath: '/wt/abc',
  mcpConfigPath: '/wt/abc/.intersect-review-mcp.json',
  prompt: 'Review this PR.'
}

describe('buildReviewSpawnSpec', () => {
  test('launches the ordinary shell-resolved Claude Code in the PR worktree', () => {
    const spec = buildReviewSpawnSpec(base)

    expect(spec.file).toBe('/bin/zsh')
    expect(spec.args).toEqual(['-l'])
    expect(spec.cwd).toBe('/wt/abc')
    expect(spec.initialCommand).toMatch(/^stty -ixon; claude /)
    expect(spec.env).toMatchObject({
      PATH: '/usr/bin',
      TERM: 'xterm-256color',
      CLAUDE_PLUGIN_SETTING: 'ambient-value'
    })
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  test('adds the local draft MCP server without suppressing normal Claude configuration', () => {
    const spec = buildReviewSpawnSpec(base)
    const command = spec.initialCommand

    expect(command).toContain('--mcp-config "$INTERSECT_REVIEW_MCP_CONFIG"')
    expect(spec.env.INTERSECT_REVIEW_MCP_CONFIG).toBe('/wt/abc/.intersect-review-mcp.json')
    for (const isolationFlag of [
      '--strict-mcp-config',
      '--setting-sources',
      '--settings ',
      '--allowed-tools',
      '--disallowed-tools',
      '--permission-mode'
    ]) {
      expect(command).not.toContain(isolationFlag)
    }
  })

  test('keeps the ordinary user, project, and local setting sources available', () => {
    const spec = buildReviewSpawnSpec(base)

    expect(spec.initialCommand).not.toContain('--setting-sources')
  })

  test('strips credentials from the environment while keeping Claude auth vars', () => {
    const spec = buildReviewSpawnSpec({
      ...base,
      env: {
        ...base.env,
        AZURE_DEVOPS_EXT_PAT: 'ado-secret',
        GITHUB_TOKEN: 'gh-secret',
        NPM_SECRET: 'npm-secret',
        DB_PASSWORD: 'db-secret',
        ANTHROPIC_API_KEY: 'anthropic-key',
        CLAUDE_CODE_OAUTH_TOKEN: 'claude-token'
      }
    })

    expect(spec.env.AZURE_DEVOPS_EXT_PAT).toBeUndefined()
    expect(spec.env.GITHUB_TOKEN).toBeUndefined()
    expect(spec.env.NPM_SECRET).toBeUndefined()
    expect(spec.env.DB_PASSWORD).toBeUndefined()
    expect(spec.env.ANTHROPIC_API_KEY).toBe('anthropic-key')
    expect(spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('claude-token')
    expect(spec.env.PATH).toBe('/usr/bin')
  })

  test('keeps the review interactive and directs findings to local drafts for human approval', () => {
    const spec = buildReviewSpawnSpec(base)
    const command = spec.initialCommand

    expect(command).not.toMatch(/(?:^|\s)(?:--print|-p)(?:\s|$)/)
    expect(command).toContain('--append-system-prompt "$INTERSECT_REVIEW_SYSTEM_PROMPT"')
    expect(spec.env.INTERSECT_REVIEW_SYSTEM_PROMPT).toMatch(/record_draft_comment/)
    expect(spec.env.INTERSECT_REVIEW_SYSTEM_PROMPT).toMatch(/human approval/i)
    expect(spec.env.INTERSECT_REVIEW_SYSTEM_PROMPT).toMatch(/never publish/i)
    expect(spec.env.INTERSECT_REVIEW_PROMPT).toBe('Review this PR.')
    // The review methodology/language comes from the supplied prompt. A fixed Czech guide here
    // would silently override the user's custom prompt.
    expect(spec.env.INTERSECT_REVIEW_SYSTEM_PROMPT).not.toMatch(
      /Průvodce code review|výhradně česky/
    )
  })

  test('keeps a long arbitrary prompt out of canonical PTY input and preserves it exactly in env', () => {
    const prompt = `${"Review O'Brien's $(change) and `backticks`.\n".repeat(500)}control:\u0003`
    const spec = buildReviewSpawnSpec({ ...base, prompt })

    expect(spec.initialCommand).toBe(
      'stty -ixon; claude --mcp-config "$INTERSECT_REVIEW_MCP_CONFIG" ' +
        '--append-system-prompt "$INTERSECT_REVIEW_SYSTEM_PROMPT" -- "$INTERSECT_REVIEW_PROMPT"'
    )
    expect(spec.initialCommand).not.toContain("O'Brien")
    expect(spec.initialCommand).not.toContain('$(change)')
    expect(spec.env.INTERSECT_REVIEW_PROMPT).toBe(prompt)
    expect(spec.initialCommand).toMatch(/ -- "\$INTERSECT_REVIEW_PROMPT"$/)
  })

  test('rejects only NUL, which process environment values cannot represent', () => {
    expect(() => buildReviewSpawnSpec({ ...base, prompt: 'Review this\0ignore me' })).toThrow(/NUL/)
    expect(() =>
      buildReviewSpawnSpec({ ...base, mcpConfigPath: '/wt/config\0.json' })
    ).toThrow(/NUL/)
  })

  test('separates the prompt from CLI options so a leading dash stays prompt text', () => {
    const spec = buildReviewSpawnSpec({ ...base, prompt: '--print this phrase verbatim' })

    expect(spec.env.INTERSECT_REVIEW_PROMPT).toBe('--print this phrase verbatim')
    expect(spec.initialCommand).toMatch(/ -- "\$INTERSECT_REVIEW_PROMPT"$/)
  })
})
