import { describe, expect, test } from 'vitest'
import {
  buildReviewSpawnSpec,
  REVIEW_ALLOWED_TOOLS,
  REVIEW_DISALLOWED_TOOLS
} from './reviewSpawn'

const base = {
  claudePath: '/Users/me/.local/bin/claude',
  worktreePath: '/wt/abc',
  mcpConfigPath: '/wt/abc/.intersect-review-mcp.json',
  prompt: 'Review this PR.'
}

/** Read the value that follows a flag in the args array. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

describe('buildReviewSpawnSpec', () => {
  test('spawns claude in the worktree', () => {
    const spec = buildReviewSpawnSpec(base)
    expect(spec.file).toBe(base.claudePath)
    expect(spec.cwd).toBe('/wt/abc')
    expect(spec.args.at(-1)).toBe('Review this PR.')
  })

  test('uses only our MCP config (strict) so no Azure DevOps tool exists in the session', () => {
    const { args } = buildReviewSpawnSpec(base)
    expect(flagValue(args, '--mcp-config')).toBe(base.mcpConfigPath)
    expect(args).toContain('--strict-mcp-config')
  })

  test('pins setting-sources to none by default so ambient allow rules cannot widen the session', () => {
    const { args } = buildReviewSpawnSpec(base)
    expect(args).toContain('--setting-sources')
    expect(flagValue(args, '--setting-sources')).toBe('')
  })

  test('closed allowlist under dontAsk: only read + draft tools, no ADO write tool', () => {
    const { args } = buildReviewSpawnSpec(base)
    expect(flagValue(args, '--permission-mode')).toBe('dontAsk')
    const allowed = flagValue(args, '--allowed-tools') ?? ''
    expect(allowed).toBe(REVIEW_ALLOWED_TOOLS.join(' '))
    expect(allowed).toContain('mcp__intersectReview__record_draft_comment')
    // Guarantee: no azureDevOps tool is ever allowed.
    expect(allowed).not.toMatch(/azureDevOps/i)
  })

  test('hard-denies shell/write/edit AND every network/egress tool', () => {
    const denied = flagValue(buildReviewSpawnSpec(base).args, '--disallowed-tools') ?? ''
    expect(denied).toBe(REVIEW_DISALLOWED_TOOLS.join(' '))
    for (const tool of ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task']) {
      expect(denied.split(' ')).toContain(tool)
    }
  })

  test('denies reads of credential files via a --settings deny list', () => {
    const settings = flagValue(buildReviewSpawnSpec(base).args, '--settings') ?? '{}'
    const parsed = JSON.parse(settings) as { permissions?: { deny?: string[] } }
    const deny = parsed.permissions?.deny ?? []
    expect(deny.some((r) => r.includes('.claude.json'))).toBe(true)
    expect(deny.some((r) => r.includes('.ssh'))).toBe(true)
  })

  test('appends a read-only/draft-only system prompt', () => {
    const prompt = flagValue(buildReviewSpawnSpec(base).args, '--append-system-prompt') ?? ''
    expect(prompt).toMatch(/READ-ONLY/)
    expect(prompt).toMatch(/record_draft_comment/)
  })

  test('appends the Czech review guide (language + concise style) alongside the security prompt', () => {
    const prompt = flagValue(buildReviewSpawnSpec(base).args, '--append-system-prompt') ?? ''
    expect(prompt).toMatch(/česky/i)
    expect(prompt).toMatch(/bez\s+štítk/i)
  })

  test('voting stays out of the AI review: no vote or ADO tool is allowed, only the draft MCP server', () => {
    for (const tool of REVIEW_ALLOWED_TOOLS) {
      expect(tool).not.toMatch(/vote|azure|devops|pull_?request|reviewer/i)
    }
    // The only MCP tool the session may call is the local draft recorder - the strict MCP config
    // exposes intersectReview alone, so no other server (and no vote surface) exists at all.
    const mcpTools = REVIEW_ALLOWED_TOOLS.filter((t) => t.startsWith('mcp__'))
    expect(mcpTools).toEqual(['mcp__intersectReview__record_draft_comment'])
  })
})
