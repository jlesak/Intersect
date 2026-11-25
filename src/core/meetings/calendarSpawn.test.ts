import { describe, expect, test } from 'vitest'
import { buildCalendarSpawnSpec } from './calendarSpawn'

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
    expect(spec.args).toContain('mcp__intersectMeetings__report_meetings')
    const denied = spec.args.slice(spec.args.indexOf('--disallowed-tools') + 1,
      spec.args.indexOf('--permission-mode'))
    expect(denied).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit', 'Read']))
    expect(spec.args.at(-1)).toContain('2026-11-25')
    expect(spec.args.at(-1)).toContain('report_meetings')
  })
})
