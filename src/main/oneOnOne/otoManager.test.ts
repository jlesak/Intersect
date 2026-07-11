import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { OtoRun } from '@common/domain'
import { createOtoRunRepo, type OtoRunRepo } from '../db/otoRunRepo'
import { makeTestDb, makeTestDeps } from '../db/testkit'
import type { PtyProcess, SpawnRequest } from '../pty/sessionManager'
import { createOtoManager, secretShadowEnv, sweepStaleOtoTempFiles, type OtoStartRequest } from './otoManager'

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
    pause: () => {},
    resume: () => {},
    kill: vi.fn(() => triggerExit(0)),
    triggerExit
  }
}

/** The socket path + session id main handed to the (would-be) MCP server via the temp config. */
async function readWiring(req: SpawnRequest): Promise<{ sock: string; session: string }> {
  const configPath = req.args[req.args.indexOf('--mcp-config') + 1]
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    mcpServers: {
      intersectOneOnOne: { env: { INTERSECT_OTO_SOCK: string; INTERSECT_OTO_SESSION: string } }
    }
  }
  const env = config.mcpServers.intersectOneOnOne.env
  return { sock: env.INTERSECT_OTO_SOCK, session: env.INTERSECT_OTO_SESSION }
}

function reportOverSocket(sock: string, payload: Record<string, unknown>): void {
  const conn = createConnection(sock, () => {
    conn.write(JSON.stringify(payload) + '\n', () => conn.end())
  })
  conn.on('error', () => {})
}

interface Harness {
  repo: OtoRunRepo
  changed: OtoRun[]
  /** Resolves with the next onRunChanged broadcast. */
  nextChange(): Promise<OtoRun>
  onRunChanged(run: OtoRun): void
}

function makeHarness(): Harness {
  const repo = createOtoRunRepo(makeTestDb(), makeTestDeps())
  const changed: OtoRun[] = []
  const waiters: ((run: OtoRun) => void)[] = []
  return {
    repo,
    changed,
    nextChange: () =>
      new Promise<OtoRun>((resolve) => {
        waiters.push(resolve)
      }),
    onRunChanged: (run) => {
      changed.push(run)
      waiters.splice(0).forEach((w) => w(run))
    }
  }
}

const processReq: OtoStartRequest = {
  type: 'process',
  person: 'Marek K.',
  vttPath: '/tmp/marek.vtt',
  todoMentions: []
}

const prepReq: OtoStartRequest = {
  type: 'prep',
  person: 'Tereza N.',
  todoMentions: ['- [open] Ask Tereza about the rate limit fix']
}

describe('createOtoManager', () => {
  test('a process report lands as a done run with the Notion/Slack result and kills the PTY', async () => {
    const h = makeHarness()
    const pty = fakePty()
    const spawn = vi.fn((req: SpawnRequest) => {
      void readWiring(req).then(({ sock, session }) =>
        reportOverSocket(sock, {
          sessionId: session,
          tool: 'report_process_result',
          ok: true,
          notionUrl: 'https://www.notion.so/page-1',
          slackDraftCreated: true,
          slackChannelLink: 'https://greencode.slack.com/archives/D1'
        })
      )
      return pty
    })
    const manager = createOtoManager({
      spawn,
      claudePath: 'claude',
      reportServerPath: '/out/otoReportServer.js',
      runs: h.repo,
      userSettingsPath: '/nonexistent/settings.json',
      onRunChanged: h.onRunChanged,
      processTimeoutMs: 5_000
    })

    const started = manager.start(processReq)
    expect(started.status).toBe('running')
    expect(h.repo.get(started.id)!.status).toBe('running')

    const finished = await h.nextChange()
    expect(finished.id).toBe(started.id)
    expect(finished.status).toBe('done')
    expect(finished.notionUrl).toBe('https://www.notion.so/page-1')
    expect(finished.slackDraftCreated).toBe(true)
    expect(finished.slackChannelLink).toBe('https://greencode.slack.com/archives/D1')
    expect(h.repo.get(started.id)!.status).toBe('done')
    expect(pty.kill).toHaveBeenCalled()
  })

  test('a prep report lands as a done run carrying the markdown briefing', async () => {
    const h = makeHarness()
    const spawn = vi.fn((req: SpawnRequest) => {
      void readWiring(req).then(({ sock, session }) =>
        reportOverSocket(sock, {
          sessionId: session,
          tool: 'report_prep_result',
          ok: true,
          markdown: '## Previous 1:1\n- agreed things'
        })
      )
      return fakePty()
    })
    const manager = createOtoManager({
      spawn,
      claudePath: 'claude',
      reportServerPath: '/x.js',
      runs: h.repo,
      userSettingsPath: '/nonexistent/settings.json',
      onRunChanged: h.onRunChanged,
      prepTimeoutMs: 5_000
    })

    const started = manager.start(prepReq)
    const finished = await h.nextChange()
    expect(finished.id).toBe(started.id)
    expect(finished.status).toBe('done')
    expect(finished.resultMarkdown).toBe('## Previous 1:1\n- agreed things')
  })

  test('an ok=false report lands as a failed run with the reported error', async () => {
    const h = makeHarness()
    const spawn = vi.fn((req: SpawnRequest) => {
      void readWiring(req).then(({ sock, session }) =>
        reportOverSocket(sock, {
          sessionId: session,
          tool: 'report_prep_result',
          ok: false,
          error: 'Notion is unreachable'
        })
      )
      return fakePty()
    })
    const manager = createOtoManager({
      spawn,
      claudePath: 'claude',
      reportServerPath: '/x.js',
      runs: h.repo,
      userSettingsPath: '/nonexistent/settings.json',
      onRunChanged: h.onRunChanged,
      prepTimeoutMs: 5_000
    })

    manager.start(prepReq)
    const finished = await h.nextChange()
    expect(finished.status).toBe('failed')
    expect(finished.error).toBe('Notion is unreachable')
  })

  test('a report for a different session id is ignored (timeout lands)', async () => {
    const h = makeHarness()
    const spawn = vi.fn((req: SpawnRequest) => {
      void readWiring(req).then(({ sock }) => {
        reportOverSocket(sock, { sessionId: 'someone-else', tool: 'report_prep_result', ok: true })
      })
      return fakePty()
    })
    const manager = createOtoManager({
      spawn,
      claudePath: 'claude',
      reportServerPath: '/x.js',
      runs: h.repo,
      userSettingsPath: '/nonexistent/settings.json',
      onRunChanged: h.onRunChanged,
      prepTimeoutMs: 200
    })

    manager.start(prepReq)
    const finished = await h.nextChange()
    expect(finished.status).toBe('failed')
    expect(finished.error).toMatch(/timed out/)
  })

  test('a report through the wrong tool fails the run immediately, not by timeout', async () => {
    const h = makeHarness()
    const spawn = vi.fn((req: SpawnRequest) => {
      void readWiring(req).then(({ sock, session }) => {
        reportOverSocket(sock, { sessionId: session, tool: 'report_process_result', ok: true })
      })
      return fakePty()
    })
    const manager = createOtoManager({
      spawn,
      claudePath: 'claude',
      reportServerPath: '/x.js',
      runs: h.repo,
      userSettingsPath: '/nonexistent/settings.json',
      onRunChanged: h.onRunChanged,
      prepTimeoutMs: 60_000
    })

    manager.start(prepReq)
    const finished = await h.nextChange()
    expect(finished.status).toBe('failed')
    expect(finished.error).toMatch(/wrong tool/)
  })

  test('a PTY exit before any report lands as a failed run', async () => {
    const h = makeHarness()
    const pty = fakePty()
    const spawn = vi.fn(() => {
      setTimeout(() => pty.triggerExit(1), 10)
      return pty
    })
    const manager = createOtoManager({
      spawn,
      claudePath: 'claude',
      reportServerPath: '/x.js',
      runs: h.repo,
      userSettingsPath: '/nonexistent/settings.json',
      onRunChanged: h.onRunChanged,
      processTimeoutMs: 5_000
    })

    manager.start(processReq)
    const finished = await h.nextChange()
    expect(finished.status).toBe('failed')
    expect(finished.error).toMatch(/exited before reporting/)
  })

  test('the timeout kills a session that never reports', async () => {
    const h = makeHarness()
    const pty = fakePty()
    const manager = createOtoManager({
      spawn: vi.fn(() => pty),
      claudePath: 'claude',
      reportServerPath: '/x.js',
      runs: h.repo,
      userSettingsPath: '/nonexistent/settings.json',
      onRunChanged: h.onRunChanged,
      prepTimeoutMs: 30
    })

    manager.start(prepReq)
    const finished = await h.nextChange()
    expect(finished.status).toBe('failed')
    expect(finished.error).toMatch(/timed out/)
    expect(pty.kill).toHaveBeenCalled()
  })

  test('a spawn failure lands as a failed run instead of throwing', async () => {
    const h = makeHarness()
    const manager = createOtoManager({
      spawn: vi.fn(() => {
        throw new Error('claude not found')
      }),
      claudePath: 'claude',
      reportServerPath: '/x.js',
      runs: h.repo,
      userSettingsPath: '/nonexistent/settings.json',
      onRunChanged: h.onRunChanged,
      prepTimeoutMs: 1_000
    })

    manager.start(prepReq)
    const finished = await h.nextChange()
    expect(finished.status).toBe('failed')
    expect(finished.error).toMatch(/claude not found/)
  })

  test('concurrent runs are independent sessions and resolve separately', async () => {
    const h = makeHarness()
    // Wiring per workflow, told apart by which report tool the prompt names.
    const wirings: Record<string, { sock: string; session: string }> = {}
    const spawn = vi.fn((req: SpawnRequest) => {
      const kind = req.args[req.args.length - 1].includes('report_prep_result') ? 'prep' : 'process'
      void readWiring(req).then((w) => (wirings[kind] = w))
      return fakePty()
    })
    const manager = createOtoManager({
      spawn,
      claudePath: 'claude',
      reportServerPath: '/x.js',
      runs: h.repo,
      userSettingsPath: '/nonexistent/settings.json',
      onRunChanged: h.onRunChanged,
      processTimeoutMs: 5_000,
      prepTimeoutMs: 5_000
    })

    const processRun = manager.start(processReq)
    const prepRun = manager.start(prepReq)
    await vi.waitFor(() => expect(Object.keys(wirings).sort()).toEqual(['prep', 'process']))
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(wirings.process.sock).not.toBe(wirings.prep.sock)

    // Finish only the prep run; the process run must stay running.
    const prepChange = h.nextChange()
    reportOverSocket(wirings.prep.sock, {
      sessionId: wirings.prep.session,
      tool: 'report_prep_result',
      ok: true,
      markdown: 'briefing'
    })
    const prepFinished = await prepChange
    expect(prepFinished.id).toBe(prepRun.id)
    expect(h.repo.get(processRun.id)!.status).toBe('running')

    const processChange = h.nextChange()
    reportOverSocket(wirings.process.sock, {
      sessionId: wirings.process.session,
      tool: 'report_process_result',
      ok: true,
      notionUrl: 'https://www.notion.so/x',
      slackDraftCreated: false
    })
    const processFinished = await processChange
    expect(processFinished.id).toBe(processRun.id)
    expect(processFinished.status).toBe('done')
    expect(processFinished.slackDraftCreated).toBe(false)
    expect(processFinished.slackChannelLink).toBeNull()
  })

  test('dispose kills every live session and stops all DB writes', async () => {
    const h = makeHarness()
    const ptys: FakePty[] = []
    const spawn = vi.fn(() => {
      const pty = fakePty()
      ptys.push(pty)
      return pty
    })
    const manager = createOtoManager({
      spawn,
      claudePath: 'claude',
      reportServerPath: '/x.js',
      runs: h.repo,
      userSettingsPath: '/nonexistent/settings.json',
      onRunChanged: h.onRunChanged,
      processTimeoutMs: 5_000,
      prepTimeoutMs: 5_000
    })

    const a = manager.start(processReq)
    const b = manager.start(prepReq)
    await vi.waitFor(() => expect(ptys).toHaveLength(2))

    manager.dispose()
    expect(ptys[0].kill).toHaveBeenCalled()
    expect(ptys[1].kill).toHaveBeenCalled()
    // The kill-triggered exits must not mark the rows failed after dispose (the DB is closing on
    // quit; the rows are reconciled on next boot instead).
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.changed).toHaveLength(0)
    expect(h.repo.get(a.id)!.status).toBe('running')
    expect(h.repo.get(b.id)!.status).toBe('running')
  })
})

describe('sweepStaleOtoTempFiles', () => {
  test('removes only old 1:1 temp files, keeping fresh ones and foreign names', async () => {
    const stale = join(tmpdir(), 'ioto-00000000.json')
    const fresh = join(tmpdir(), 'ioto-11111111.json')
    const foreign = join(tmpdir(), 'ioto-notarun.json')
    await writeFile(stale, '{}')
    await writeFile(fresh, '{}')
    await writeFile(foreign, '{}')
    const old = new Date(Date.now() - 60 * 60_000)
    await utimes(stale, old, old)

    await sweepStaleOtoTempFiles()

    await expect(readFile(stale, 'utf8')).rejects.toThrow()
    await expect(readFile(fresh, 'utf8')).resolves.toBe('{}')
    await expect(readFile(foreign, 'utf8')).resolves.toBe('{}')
    await Promise.all([fresh, foreign].map((p) => rm(p, { force: true })))
  })
})

describe('secretShadowEnv', () => {
  test('shadows only secret-looking keys, keeping ANTHROPIC_/CLAUDE_ and benign vars', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ioto-shadow-test-'))
    const path = join(dir, 'settings.json')
    await writeFile(
      path,
      JSON.stringify({
        env: {
          AZURE_DEVOPS_PAT: 'secret',
          TOGGL_API_TOKEN: 'secret',
          OPENAI_API_KEY: 'secret',
          ANTHROPIC_API_KEY: 'keep',
          SOME_FLAG: '1'
        }
      })
    )
    expect(await secretShadowEnv(path)).toEqual({
      AZURE_DEVOPS_PAT: '',
      TOGGL_API_TOKEN: '',
      OPENAI_API_KEY: ''
    })
  })

  test('a missing or unreadable settings file shadows nothing', async () => {
    expect(await secretShadowEnv('/nonexistent/settings.json')).toEqual({})
  })
})
