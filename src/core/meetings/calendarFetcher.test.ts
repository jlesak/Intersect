import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { PassThrough } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'
import { createCalendarFetcher } from './calendarFetcher'
import { insideAppData } from '../timeTracking/exclusions'

function fakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), kill: vi.fn() })
  return child
}

async function report(configPath: string, payload: Record<string, unknown>): Promise<void> {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as { mcpServers: {
    intersectMeetings: { env: Record<string, string> }
  } }
  const env = config.mcpServers.intersectMeetings.env
  await new Promise<void>((resolve, reject) => {
    const conn = createConnection(env.INTERSECT_MEETINGS_SOCK, () => {
      conn.end(JSON.stringify({ sessionId: env.INTERSECT_MEETINGS_SESSION,
        day: '2026-11-25', events: [], ...payload }) + '\n')
    })
    conn.on('error', reject)
    conn.on('close', () => resolve())
  })
}

describe('calendar fetcher', () => {
  test('bootstraps account MCP then accepts only the matching report', async () => {
    const child = fakeChild()
    let args!: string[]
    let cwd!: string
    let env!: NodeJS.ProcessEnv
    const launch = vi.fn((_file: string, a: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      args = a; cwd = opts.cwd ?? ''; env = opts.env ?? {}; return child
    }) as unknown as typeof spawn
    let input = ''
    child.stdin.on('data', (chunk: Buffer) => { input += chunk.toString('utf8') })
    const fetcher = createCalendarFetcher({ launch, claudePath: 'claude',
      reportServerPath: '/out/meetingsReportServer.js', execPath: '/Intersect',
      cwd: '/synthetic/intersect', timeoutMs: 1000 })
    const pending = fetcher.fetch('2026-11-25')
    await vi.waitFor(() => expect(input).toContain('READY'))
    expect(insideAppData(cwd, '/synthetic/intersect')).toBe(true)
    expect(env.CLAUDE_CODE_SKIP_PROMPT_HISTORY).toBe('1')
    expect(args).not.toContain('--strict-mcp-config')
    const stdout = child.stdout as PassThrough
    stdout.write(JSON.stringify({ type: 'result', result: 'READY' }) + '\n')
    await vi.waitFor(() => expect(input).toContain('2026-11-25'))
    const configPath = args[args.indexOf('--mcp-config') + 1]
    await report(configPath, { sessionId: 'wrong', events: [{ id: 'wrong' }] })
    await report(configPath, { events: [{ id: 'synthetic', subject: 'Test',
      start: '2026-11-25T09:00:00+01:00', end: '2026-11-25T09:30:00+01:00' }] })
    await expect(pending).resolves.toMatchObject([{ id: 'synthetic' }])
    expect(child.kill).toHaveBeenCalled()
  })

  test('retries after the first request result and reports waiting permission', async () => {
    const child = fakeChild()
    const fetcher = createCalendarFetcher({ launch: (() => child) as unknown as typeof spawn,
      claudePath: 'claude', reportServerPath: '/out/meetingsReportServer.js',
      execPath: '/Intersect', cwd: '/synthetic/intersect', timeoutMs: 1000 })
    let input = ''
    child.stdin.on('data', (chunk: Buffer) => { input += chunk.toString('utf8') })
    const pending = fetcher.fetch('2026-11-25')
    await vi.waitFor(() => expect(input).toContain('READY'))
    const stdout = child.stdout as PassThrough
    stdout.write('{"type":"result"}\n{"type":"result"}\n')
    await vi.waitFor(() => expect(input).toContain('Retry the calendar request'))
    stdout.write('{"type":"control_request"}\n')
    await expect(pending).rejects.toThrow(/permission/i)
  })

  test('reports a missing connector on timeout without calling any calendar', async () => {
    const fetcher = createCalendarFetcher({ launch: (() => fakeChild()) as unknown as typeof spawn,
      claudePath: 'claude', reportServerPath: '/out/meetingsReportServer.js',
      execPath: '/Intersect', cwd: '/synthetic/intersect', timeoutMs: 30 })
    await expect(fetcher.fetch('2026-11-25')).rejects.toThrow(/connect|auth|time/i)
  })
})
