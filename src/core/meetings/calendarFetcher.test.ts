import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { describe, expect, test, vi } from 'vitest'
import type { PtyProcess, SpawnRequest } from '../pty/sessionManager'
import { createCalendarFetcher } from './calendarFetcher'
import { insideAppData } from '../timeTracking/exclusions'

function pty(): PtyProcess & { emitData(data: string): void; emitExit(): void } {
  let dataCb: (data: string) => void = () => {}
  let exitCb: (event: { exitCode: number }) => void = () => {}
  return {
    pid: 1, onData: cb => { dataCb = cb }, onExit: cb => { exitCb = cb },
    write: vi.fn(), resize: () => {}, pause: () => {}, resume: () => {},
    kill: vi.fn(), emitData: data => dataCb(data), emitExit: () => exitCb({ exitCode: 1 })
  }
}

async function report(req: SpawnRequest, payload: Record<string, unknown>): Promise<void> {
  const path = req.args[req.args.indexOf('--mcp-config') + 1]
  const config = JSON.parse(await readFile(path, 'utf8')) as { mcpServers: {
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
  test('accepts only a matching report from the production socket wiring', async () => {
    const child = pty()
    let request!: SpawnRequest
    const fetcher = createCalendarFetcher({ spawn: req => { request = req; return child },
      claudePath: 'claude', reportServerPath: '/out/meetingsReportServer.js',
      execPath: '/Intersect', cwd: '/synthetic/intersect', timeoutMs: 1000, retryMs: 10 })
    const pending = fetcher.fetch('2026-11-25')
    await vi.waitFor(() => expect(request).toBeDefined())
    expect(insideAppData(request.cwd, '/synthetic/intersect')).toBe(true)
    await report(request, { sessionId: 'wrong', events: [{ id: 'wrong' }] })
    await report(request, { events: [{ id: 'synthetic', subject: 'Test',
      start: '2026-11-25T09:00:00+01:00', end: '2026-11-25T09:30:00+01:00' }] })
    await expect(pending).resolves.toMatchObject([{ id: 'synthetic' }])
    expect(child.kill).toHaveBeenCalled()
  })

  test('retries a late connector then fails a waiting permission prompt', async () => {
    const child = pty()
    const fetcher = createCalendarFetcher({ spawn: () => child, claudePath: 'claude',
      reportServerPath: '/out/meetingsReportServer.js', execPath: '/Intersect',
      cwd: '/synthetic/intersect', timeoutMs: 1000, retryMs: 10 })
    const pending = fetcher.fetch('2026-11-25')
    await vi.waitFor(() => expect(child.write).toHaveBeenCalled())
    child.emitData('Waiting for permission to use calendar')
    await expect(pending).rejects.toThrow(/permission/i)
  })

  test('reports a missing connector on timeout without calling any calendar', async () => {
    const fetcher = createCalendarFetcher({ spawn: () => pty(), claudePath: 'claude',
      reportServerPath: '/out/meetingsReportServer.js', execPath: '/Intersect',
      cwd: '/synthetic/intersect', timeoutMs: 30, retryMs: 10 })
    await expect(fetcher.fetch('2026-11-25')).rejects.toThrow(/connect|auth|timed out/i)
  })
})
