import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { createCalendarFetcher } from './calendarFetcher'

test.skipIf(process.env.INTERSECT_SYNTHETIC_CALENDAR_SMOKE !== '1')(
  'production calendar transport reads synthetic event detail via real Claude and report socket',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'intersect-meeting-synthetic-'))
    const calls = join(dir, 'calls')
    const fetcher = createCalendarFetcher({
      cwd: dir,
      claudePath: process.env.INTERSECT_CLAUDE_PATH ?? 'claude',
      reportServerPath: resolve('out/main/meetingsReportServer.js'),
      execPath: process.execPath,
      timeoutMs: 100_000,
      strictMcpConfig: true,
      syntheticMcpServers: { claude_ai_Microsoft_365: {
        command: process.execPath,
        args: [resolve('evals/meeting-calendar/syntheticCalendarMcp.mjs')],
        env: { SYNTHETIC_CALENDAR_CALLS: calls }
      } }
    })
    try {
      const events = await fetcher.fetch('2026-11-25')
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
        id: 'synthetic-event-1', onlineMeeting: {
          joinUrl: 'https://teams.microsoft.com/l/meetup-join/synthetic-detail'
        }
      })]))
      expect(await readFile(calls, 'utf8')).toBe('search\nread\n')
    } finally {
      fetcher.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000
)
