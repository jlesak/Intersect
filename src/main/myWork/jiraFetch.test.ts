import { readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { PtyProcess, SpawnRequest } from '../pty/sessionManager'
import { createJiraFetcher, sweepStaleTempFiles } from './jiraFetch'

// A probe that says the saved session works, so tests exercise the fetch itself.
const probeOk = async (): Promise<'ok'> => 'ok'

interface FakePty extends PtyProcess {
  kill: () => void
  triggerExit(exitCode: number): void
}

function fakePty(): FakePty {
  const exitCbs: ((e: { exitCode: number }) => void)[] = []
  let exited = false
  const triggerExit = (exitCode: number): void => {
    if (exited) return
    exited = true
    exitCbs.forEach((cb) => cb({ exitCode }))
  }
  return {
    pid: 1,
    onData: () => {},
    onExit: (cb) => exitCbs.push(cb),
    write: () => {},
    resize: () => {},
    kill: vi.fn(() => triggerExit(0)),
    triggerExit
  }
}

/** The socket path + session id main handed to the (would-be) MCP server via the temp config. */
async function readWiring(req: SpawnRequest): Promise<{ sock: string; session: string }> {
  const configPath = req.args[req.args.indexOf('--mcp-config') + 1]
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    mcpServers: { intersectJira: { env: { INTERSECT_JIRA_SOCK: string; INTERSECT_JIRA_SESSION: string } } }
  }
  const env = config.mcpServers.intersectJira.env
  return { sock: env.INTERSECT_JIRA_SOCK, session: env.INTERSECT_JIRA_SESSION }
}

function reportOverSocket(sock: string, payload: Record<string, unknown>): void {
  const conn = createConnection(sock, () => {
    conn.write(JSON.stringify(payload) + '\n', () => conn.end())
  })
  conn.on('error', () => {})
}

describe('createJiraFetcher', () => {
  test('resolves with the mapped board once the session reports, then kills the PTY', async () => {
    const pty = fakePty()
    const spawn = vi.fn((req: SpawnRequest) => {
      void readWiring(req).then(({ sock, session }) =>
        reportOverSocket(sock, {
          sessionId: session,
          ok: true,
          issues: [
            {
              key: 'FID2507-611',
              summary: 'Do the thing',
              status: 'In Review',
              priority: 'High',
              updated: '2026-07-01T08:00:00Z'
            }
          ]
        })
      )
      return pty
    })
    const fetcher = createJiraFetcher({
      spawn,
      claudePath: 'claude',
      reportServerPath: '/out/jiraReportServer.js',
      probe: probeOk,
      timeoutMs: 5_000
    })

    const result = await fetcher.fetchBoard()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.issues.map((i) => i.key)).toEqual(['FID2507-611'])
      expect(result.issues[0].column).toBe('review')
    }
    expect(pty.kill).toHaveBeenCalled()
  })

  test('writes the fetch script to a main-owned temp file, pins Bash to it, and cleans it up', async () => {
    let scriptOnDisk = ''
    let allowedBashRule = ''
    let scriptPath = ''
    const spawn = vi.fn((req: SpawnRequest) => {
      allowedBashRule = req.args[req.args.indexOf('--allowed-tools') + 1]
      scriptPath = allowedBashRule.slice('Bash('.length, -1).split(' ')[1]
      void readFile(scriptPath, 'utf8')
        .then((content) => (scriptOnDisk = content))
        .then(() => readWiring(req))
        .then(({ sock, session }) => reportOverSocket(sock, { sessionId: session, ok: true, issues: [] }))
      return fakePty()
    })
    const fetcher = createJiraFetcher({
      spawn,
      claudePath: 'claude',
      reportServerPath: '/x.js',
      probe: probeOk,
      timeoutMs: 5_000
    })

    await fetcher.fetchBoard()
    expect(allowedBashRule).toMatch(/^Bash\(\S+\/\.claude\/skills\/jira\/\.venv\/bin\/python \S+\.py\)$/)
    expect(scriptOnDisk).toContain('storageState.json')
    await expect(readFile(scriptPath, 'utf8')).rejects.toThrow()
  })

  test('a report for a different session id is ignored', async () => {
    const spawn = vi.fn((req: SpawnRequest) => {
      void readWiring(req).then(({ sock }) =>
        reportOverSocket(sock, { sessionId: 'someone-else', ok: true, issues: [] })
      )
      return fakePty()
    })
    const fetcher = createJiraFetcher({
      spawn,
      claudePath: 'claude',
      reportServerPath: '/x.js',
      probe: probeOk,
      timeoutMs: 150
    })
    const result = await fetcher.fetchBoard()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/timed out/)
  })

  test('a PTY exit before any report resolves as a failure', async () => {
    const pty = fakePty()
    const spawn = vi.fn(() => {
      setTimeout(() => pty.triggerExit(1), 10)
      return pty
    })
    const fetcher = createJiraFetcher({
      spawn,
      claudePath: 'claude',
      reportServerPath: '/x.js',
      probe: probeOk,
      timeoutMs: 5_000
    })
    const result = await fetcher.fetchBoard()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/exited before reporting/)
  })

  test('the timeout kills a session that never reports', async () => {
    const pty = fakePty()
    const fetcher = createJiraFetcher({
      spawn: vi.fn(() => pty),
      claudePath: 'claude',
      reportServerPath: '/x.js',
      probe: probeOk,
      timeoutMs: 30
    })
    const result = await fetcher.fetchBoard()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/timed out/)
    expect(pty.kill).toHaveBeenCalled()
  })

  test('concurrent fetchBoard calls share one hidden session', async () => {
    const pty = fakePty()
    const spawn = vi.fn((req: SpawnRequest) => {
      void readWiring(req).then(({ sock, session }) =>
        reportOverSocket(sock, { sessionId: session, ok: true, issues: [] })
      )
      return pty
    })
    const fetcher = createJiraFetcher({
      spawn,
      claudePath: 'claude',
      reportServerPath: '/x.js',
      probe: probeOk,
      timeoutMs: 5_000
    })
    const [a, b] = await Promise.all([fetcher.fetchBoard(), fetcher.fetchBoard()])
    expect(a).toBe(b)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  test('a spawn failure resolves as a failure result instead of rejecting', async () => {
    const fetcher = createJiraFetcher({
      spawn: vi.fn(() => {
        throw new Error('claude not found')
      }),
      claudePath: 'claude',
      reportServerPath: '/x.js',
      probe: probeOk,
      timeoutMs: 1_000
    })
    const result = await fetcher.fetchBoard()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/claude not found/)
  })

  test('a failing probe reports auth immediately without spawning a session', async () => {
    const spawn = vi.fn(() => fakePty())
    const fetcher = createJiraFetcher({
      spawn,
      claudePath: 'claude',
      reportServerPath: '/x.js',
      probe: async () => 'auth',
      timeoutMs: 5_000
    })
    const result = await fetcher.fetchBoard()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('auth')
      expect(result.message).toMatch(/Not logged in/)
    }
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('sweepStaleTempFiles', () => {
  test('removes only old fetch temp files, keeping fresh ones and foreign names', async () => {
    const stale = join(tmpdir(), 'imw-00000000.json')
    const fresh = join(tmpdir(), 'imw-11111111.json')
    const foreign = join(tmpdir(), 'imw-notafetch.json')
    await writeFile(stale, '{}')
    await writeFile(fresh, '{}')
    await writeFile(foreign, '{}')
    const old = new Date(Date.now() - 60 * 60_000)
    await utimes(stale, old, old)

    await sweepStaleTempFiles()

    await expect(readFile(stale, 'utf8')).rejects.toThrow()
    await expect(readFile(fresh, 'utf8')).resolves.toBe('{}')
    await expect(readFile(foreign, 'utf8')).resolves.toBe('{}')
    await Promise.all([fresh, foreign].map((p) => rm(p, { force: true })))
  })
})
