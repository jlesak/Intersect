import { describe, expect, test } from 'vitest'
import {
  buildJiraFetchPrompt,
  buildJiraSpawnSpec,
  jiraFetchAllowedTools,
  jiraFetchCommand,
  JIRA_FETCH_DENY_READ_GLOBS,
  JIRA_FETCH_DISALLOWED_TOOLS,
  JIRA_FETCH_JQL,
  JIRA_FETCH_SCRIPT
} from './jiraSpawn'

const base = {
  claudePath: '/Users/me/.local/bin/claude',
  mcpConfigPath: '/tmp/imw-abc.json',
  pythonPath: '/Users/me/.claude/skills/jira/.venv/bin/python',
  scriptPath: '/tmp/imw-abc.py',
  cwd: '/Users/me'
}

const command = jiraFetchCommand(base.pythonPath, base.scriptPath)

/** Read the value that follows a flag in the args array. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

describe('buildJiraSpawnSpec', () => {
  test('spawns claude with the prompt as the positional argument (interactive, not -p)', () => {
    const spec = buildJiraSpawnSpec(base)
    expect(spec.file).toBe(base.claudePath)
    expect(spec.cwd).toBe('/Users/me')
    expect(spec.args.at(-1)).toBe(buildJiraFetchPrompt(command))
    expect(spec.args).not.toContain('-p')
    expect(spec.args).not.toContain('--print')
  })

  test('uses only our MCP config (strict) so the report server is the only MCP tool source', () => {
    const { args } = buildJiraSpawnSpec(base)
    expect(flagValue(args, '--mcp-config')).toBe(base.mcpConfigPath)
    expect(args).toContain('--strict-mcp-config')
  })

  test('pins setting-sources to none so ambient allow rules cannot widen the session', () => {
    const { args } = buildJiraSpawnSpec(base)
    expect(flagValue(args, '--setting-sources')).toBe('')
  })

  test('allowlist under dontAsk: only the exact fetch command and the report tool, never bare Bash', () => {
    const { args } = buildJiraSpawnSpec(base)
    expect(flagValue(args, '--permission-mode')).toBe('dontAsk')
    const i = args.indexOf('--allowed-tools')
    // Each rule is its own argv element (the Bash rule contains a space).
    expect(args.slice(i + 1, i + 3)).toEqual([
      `Bash(${base.pythonPath} ${base.scriptPath})`,
      'mcp__intersectJira__report_jira_issues'
    ])
    expect(args).not.toContain('Bash')
  })

  test('denies credential-file reads via settings as a second layer', () => {
    const settings = flagValue(buildJiraSpawnSpec(base).args, '--settings') ?? '{}'
    const parsed = JSON.parse(settings) as { permissions: { deny: string[] } }
    expect(parsed.permissions.deny).toEqual(JIRA_FETCH_DENY_READ_GLOBS)
    expect(parsed.permissions.deny).toContain('Read(//**/.claude/**)')
  })

  test('hard-denies write/edit and every standalone egress tool', () => {
    const denied = flagValue(buildJiraSpawnSpec(base).args, '--disallowed-tools') ?? ''
    expect(denied).toBe(JIRA_FETCH_DISALLOWED_TOOLS.join(' '))
    for (const tool of ['Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task']) {
      expect(denied.split(' ')).toContain(tool)
    }
  })
})

describe('jiraFetchAllowedTools', () => {
  test('the Bash rule is an exact match of the fetch command, no wildcard', () => {
    expect(jiraFetchAllowedTools(command)).toEqual([
      `Bash(${command})`,
      'mcp__intersectJira__report_jira_issues'
    ])
    expect(command).not.toContain('*')
    expect(command).not.toContain('~')
  })
})

describe('JIRA_FETCH_SCRIPT', () => {
  test('runs the fixed unresolved-assigned-to-me JQL, never a user-supplied one', () => {
    expect(JIRA_FETCH_JQL).toBe('assignee = currentUser() AND resolution = EMPTY')
    expect(JIRA_FETCH_SCRIPT).toContain(JIRA_FETCH_JQL)
  })

  test('authenticates via the jira skill session file and carries no token of any kind', () => {
    expect(JIRA_FETCH_SCRIPT).toContain('storageState.json')
    expect(JIRA_FETCH_SCRIPT).not.toMatch(/\bPAT\b|Bearer|api[-_ ]?token/i)
  })
})

describe('buildJiraFetchPrompt', () => {
  test('contains the exact fetch command and no embedded script', () => {
    const prompt = buildJiraFetchPrompt(command)
    expect(prompt).toContain(command)
    expect(prompt).not.toContain('import requests')
  })

  test('demands exactly one report call and forbids touching files', () => {
    const prompt = buildJiraFetchPrompt(command)
    expect(prompt).toContain('report_jira_issues')
    expect(prompt).toMatch(/exactly once/)
    expect(prompt).toMatch(/Do not read, create, or modify any files/)
  })
})
