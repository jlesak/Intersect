import { describe, expect, test } from 'vitest'
import { buildCalendarSpawnSpec, buildCalendarPrompt } from './calendarSpawn'

describe('calendar hidden session spawn', () => {
  test('uses the account connector, report MCP, and dontAsk while denying local writes', () => {
    const spec = buildCalendarSpawnSpec({
      claudePath: '/bin/claude', mcpConfigPath: '/tmp/report.json', day: '2026-11-25',
      cwd: '/tmp', shadowEnv: { PRIVATE_TOKEN: '' }
    })
    expect(spec.args).toContain('--mcp-config')
    expect(spec.args).not.toContain('--strict-mcp-config')
    expect(spec.args.slice(spec.args.indexOf('--permission-mode') + 1)).toContain('dontAsk')
    expect(spec.args).toContain('mcp__claude_ai_Microsoft_365__outlook_calendar_search')
    expect(spec.args).toContain('mcp__claude_ai_Microsoft_365__read_resource')
    expect(spec.args).toContain('mcp__intersectMeetings__report_meetings')
    expect(spec.args).toEqual(expect.arrayContaining(['-p', '--no-session-persistence',
      '--input-format', 'stream-json', '--output-format', '--permission-prompts', 'none']))
    const denied = spec.args.slice(spec.args.indexOf('--disallowed-tools') + 1,
      spec.args.indexOf('--permission-mode'))
    expect(denied).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit', 'Read']))
    expect(spec.args).not.toContain('--strict-mcp-config')
    expect(spec.prompt).toContain('2026-11-25')
    expect(spec.prompt).toContain('report_meetings')
  })

  test('requests detail reads so a search snippet without a Join URL can be completed', () => {
    const prompt = buildCalendarPrompt('2026-11-25', 'Europe/Prague')
    expect(prompt.indexOf('Search the calendar first')).toBeLessThan(prompt.indexOf('read_resource on that event'))
    expect(prompt).toContain('onlineMeeting.joinUrl')
    expect(prompt).toContain('resource URI')
  })
})
