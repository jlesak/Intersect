import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { Project } from '@common/domain'
import { createJiraCacheRepo } from '../db/jiraCacheRepo'
import { makeTestDb } from '../db/testkit'
import type { JiraFetchResult } from './jiraClient'
import { JIRA_GLOBAL_JQL, type JiraRemoteIssue } from './jiraMapping'
import { createJiraSyncEngine, type JiraQuery, type JiraSyncEngineDeps } from './jiraSyncEngine'

const remote = (key: string, over: Partial<JiraRemoteIssue> = {}): JiraRemoteIssue => ({
  key,
  summary: `Issue ${key}`,
  description: null,
  rawStatus: 'In Progress',
  rawPriority: 'High',
  assignee: 'Jan',
  epicKey: null,
  epicSummary: null,
  estimateSeconds: null,
  components: [],
  updatedAt: 1000,
  ...over
})

const okFetch = (...keys: string[]): JiraFetchResult => ({
  ok: true,
  issues: keys.map((k) => remote(k)),
  partial: false
})

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'Project',
  sortOrder: 0,
  archived: false,
  repoPaths: ['/repo'],
  jiraJql: null,
  jiraBoardUrl: null,
  adoRepositories: [],
  togglProjectId: null,
  ...over
})

const STALE_MS = 5 * 60_000

function makeEngine(over: Partial<JiraSyncEngineDeps> = {}) {
  const runQuery = vi.fn(async () => okFetch('A-1'))
  const changed: string[] = []
  let now = 1_000_000
  const deps: JiraSyncEngineDeps = {
    runQuery,
    repo: createJiraCacheRepo(makeTestDb()),
    getProject: () => undefined,
    now: () => now,
    onChanged: (sourceKey) => changed.push(sourceKey),
    ...over
  }
  return {
    engine: createJiraSyncEngine(deps),
    runQuery: deps.runQuery as ReturnType<typeof vi.fn>,
    changed,
    repo: deps.repo,
    advance: (ms: number) => {
      now += ms
    }
  }
}

/** Wait until every queued microtask (the background refresh chain) has settled. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('getBoard', () => {
  test('a cold source answers an empty envelope immediately and starts one refresh', async () => {
    const { engine, runQuery, changed } = makeEngine()
    const board = await engine.getBoard('global')
    expect(board).toEqual({ sourceKey: 'global', issues: [], fetchedAt: null, partial: false, error: null })
    await settle()
    expect(runQuery).toHaveBeenCalledTimes(1)
    expect(changed).toEqual(['global'])
    // The next read serves the refreshed cache.
    const next = await engine.getBoard('global')
    expect(next.issues.map((i) => i.key)).toEqual(['A-1'])
  })

  test('the global source runs the fixed currentUser JQL through the injected query runner', async () => {
    const { engine, runQuery } = makeEngine()
    await engine.getBoard('global')
    await settle()
    expect(runQuery).toHaveBeenCalledWith('global', { kind: 'jql', jql: JIRA_GLOBAL_JQL })
  })

  test('a fresh cache is served without any refresh', async () => {
    const { engine, runQuery, advance } = makeEngine()
    await engine.refresh('global')
    runQuery.mockClear()
    advance(STALE_MS - 1)
    const board = await engine.getBoard('global')
    expect(board.issues.map((i) => i.key)).toEqual(['A-1'])
    await settle()
    expect(runQuery).not.toHaveBeenCalled()
  })

  test('the stale boundary is strict: exactly five minutes old does not refresh, older does', async () => {
    const { engine, runQuery, advance } = makeEngine()
    await engine.refresh('global')
    runQuery.mockClear()

    advance(STALE_MS)
    await engine.getBoard('global')
    await settle()
    expect(runQuery).not.toHaveBeenCalled()

    advance(1)
    await engine.getBoard('global')
    await settle()
    expect(runQuery).toHaveBeenCalledTimes(1)
  })

  test('concurrent stale readers share exactly one refresh', async () => {
    let resolveFetch!: (r: JiraFetchResult) => void
    const runQuery = vi.fn(() => new Promise<JiraFetchResult>((resolve) => (resolveFetch = resolve)))
    const { engine, changed } = makeEngine({ runQuery })
    await Promise.all([engine.getBoard('global'), engine.getBoard('global'), engine.getBoard('global')])
    expect(runQuery).toHaveBeenCalledTimes(1)
    resolveFetch(okFetch('A-1'))
    await settle()
    expect(changed).toEqual(['global'])
  })

  test('a failed refresh does not re-run on every subsequent read within the stale window', async () => {
    const runQuery = vi.fn(async (): Promise<JiraFetchResult> => ({ ok: false, kind: 'network', message: 'down' }))
    const { engine, advance } = makeEngine({ runQuery })
    await engine.getBoard('global')
    await settle()
    expect(runQuery).toHaveBeenCalledTimes(1)

    await engine.getBoard('global')
    await settle()
    expect(runQuery).toHaveBeenCalledTimes(1)

    // The next stale window retries once more.
    advance(STALE_MS + 1)
    await engine.getBoard('global')
    await settle()
    expect(runQuery).toHaveBeenCalledTimes(2)
  })
})

describe('refresh', () => {
  test('forces a fetch even when the cache is fresh and returns the new envelope', async () => {
    const runQuery = vi
      .fn<() => Promise<JiraFetchResult>>()
      .mockResolvedValueOnce(okFetch('A-1'))
      .mockResolvedValueOnce(okFetch('A-2'))
    const { engine } = makeEngine({ runQuery })
    await engine.refresh('global')
    const board = await engine.refresh('global')
    expect(runQuery).toHaveBeenCalledTimes(2)
    expect(board.issues.map((i) => i.key).sort()).toEqual(['A-1', 'A-2'])
  })

  test('joins a refresh already in flight instead of stacking a second fetch', async () => {
    let resolveFetch!: (r: JiraFetchResult) => void
    const runQuery = vi.fn(() => new Promise<JiraFetchResult>((resolve) => (resolveFetch = resolve)))
    const { engine } = makeEngine({ runQuery })
    const a = engine.refresh('global')
    const b = engine.refresh('global')
    resolveFetch(okFetch('A-1'))
    const [first, second] = await Promise.all([a, b])
    expect(runQuery).toHaveBeenCalledTimes(1)
    expect(first.issues.map((i) => i.key)).toEqual(['A-1'])
    expect(second.issues.map((i) => i.key)).toEqual(['A-1'])
  })

  test('announces completion for both success and failure', async () => {
    const runQuery = vi
      .fn<() => Promise<JiraFetchResult>>()
      .mockResolvedValueOnce(okFetch('A-1'))
      .mockResolvedValueOnce({ ok: false, kind: 'server', message: 'HTTP 500' })
    const { engine, changed } = makeEngine({ runQuery })
    await engine.refresh('global')
    await engine.refresh('global')
    expect(changed).toEqual(['global', 'global'])
  })

  test('a partial fetch lands with the explicit partial flag', async () => {
    const runQuery = vi.fn(async (): Promise<JiraFetchResult> => ({ ok: true, issues: [remote('A-1')], partial: true }))
    const { engine } = makeEngine({ runQuery })
    const board = await engine.refresh('global')
    expect(board.partial).toBe(true)
    expect(board.issues).toHaveLength(1)
  })

  test('a thrown query runner lands as an "other" error, never an exception', async () => {
    const runQuery = vi.fn(async () => {
      throw new Error('unexpected')
    })
    const { engine } = makeEngine({ runQuery })
    const board = await engine.refresh('global')
    expect(board.error).toEqual({ kind: 'other', message: 'unexpected' })
  })
})

describe('error retention', () => {
  test.each(['auth', 'network', 'server'] as const)(
    'a %s failure keeps the last-good issues and fetch time',
    async (kind) => {
      const runQuery = vi
        .fn<() => Promise<JiraFetchResult>>()
        .mockResolvedValueOnce(okFetch('A-1'))
        .mockResolvedValueOnce({ ok: false, kind, message: 'failed' })
      const { engine } = makeEngine({ runQuery })
      const good = await engine.refresh('global')
      expect(good.error).toBeNull()

      const bad = await engine.refresh('global')
      expect(bad.issues.map((i) => i.key)).toEqual(['A-1'])
      expect(bad.fetchedAt).toBe(good.fetchedAt)
      expect(bad.error).toEqual({ kind, message: 'failed' })
    }
  )

  test('issues missing from the latest fetch are marked absent without deleting rows', async () => {
    const runQuery = vi
      .fn<() => Promise<JiraFetchResult>>()
      .mockResolvedValueOnce(okFetch('A-1', 'A-2'))
      .mockResolvedValueOnce(okFetch('A-2'))
    const { engine } = makeEngine({ runQuery })
    await engine.refresh('global')
    const board = await engine.refresh('global')
    const byKey = Object.fromEntries(board.issues.map((i) => [i.key, i.absent]))
    expect(byKey).toEqual({ 'A-1': true, 'A-2': false })
  })
})

describe('project sources', () => {
  test('a project JQL is preferred over its board URL', async () => {
    const { engine, runQuery } = makeEngine({
      getProject: () =>
        project({
          jiraJql: 'project = FID2507',
          jiraBoardUrl: 'https://jira.skoda.vwgroup.com/secure/RapidBoard.jspa?rapidView=7'
        })
    })
    await engine.refresh('project:p1')
    expect(runQuery).toHaveBeenCalledWith('project:p1', { kind: 'jql', jql: 'project = FID2507' })
  })

  test('a board URL is parsed and used when no JQL is configured', async () => {
    const { engine, runQuery } = makeEngine({
      getProject: () =>
        project({
          jiraBoardUrl: 'https://jira.skoda.vwgroup.com/secure/RapidBoard.jspa?rapidView=51682&quickFilter=84114'
        })
    })
    await engine.refresh('project:p1')
    const query = runQuery.mock.calls[0][1] as JiraQuery
    expect(query).toEqual({ kind: 'board', board: { boardId: 51682, quickFilterId: 84114 } })
  })

  test('a project with neither JQL nor board URL is not-configured and never fetches', async () => {
    const { engine, runQuery } = makeEngine({ getProject: () => project() })
    const board = await engine.getBoard('project:p1')
    await settle()
    expect(board.error?.kind).toBe('not-configured')
    expect(runQuery).not.toHaveBeenCalled()

    const refreshed = await engine.refresh('project:p1')
    expect(refreshed.error?.kind).toBe('not-configured')
    expect(runQuery).not.toHaveBeenCalled()
  })

  test('a malformed board URL is not-configured with a readable message', async () => {
    const { engine, runQuery } = makeEngine({
      getProject: () => project({ jiraBoardUrl: 'https://jira.skoda.vwgroup.com/browse/FID2507-1' })
    })
    const board = await engine.getBoard('project:p1')
    expect(board.error?.kind).toBe('not-configured')
    expect(board.error?.message).toMatch(/invalid/i)
    expect(runQuery).not.toHaveBeenCalled()
  })

  test('a deleted project reports not-configured instead of fetching', async () => {
    const { engine, runQuery } = makeEngine({ getProject: () => undefined })
    const board = await engine.getBoard('project:ghost')
    expect(board.error?.kind).toBe('not-configured')
    expect(runQuery).not.toHaveBeenCalled()
  })

  test('project sources refresh independently of the global one', async () => {
    const { engine, runQuery } = makeEngine({
      getProject: () => project({ jiraJql: 'project = FID2507' })
    })
    await engine.refresh('global')
    await engine.refresh('project:p1')
    expect(runQuery.mock.calls.map((c) => c[0])).toEqual(['global', 'project:p1'])
  })
})

describe('normalization', () => {
  test('fetched issues land as full snapshots with canonical URLs and mapped columns', async () => {
    const runQuery = vi.fn(
      async (): Promise<JiraFetchResult> => ({
        ok: true,
        issues: [
          remote('FID2507-9', {
            rawStatus: 'Ready for Test',
            rawPriority: 'Blocker',
            epicKey: 'FID2507-100',
            epicSummary: 'Direct sync',
            estimateSeconds: 7200,
            components: ['Backend'],
            description: 'Do it',
            updatedAt: 123
          })
        ],
        partial: false
      })
    )
    const { engine } = makeEngine({ runQuery })
    const board = await engine.refresh('global')
    expect(board.issues[0]).toMatchObject({
      key: 'FID2507-9',
      url: 'https://jira.skoda.vwgroup.com/browse/FID2507-9',
      column: 'test',
      priority: 'high',
      rawStatus: 'Ready for Test',
      rawPriority: 'Blocker',
      epicKey: 'FID2507-100',
      epicSummary: 'Direct sync',
      estimateSeconds: 7200,
      components: ['Backend'],
      description: 'Do it',
      updatedAt: 123,
      absent: false
    })
  })

  test('an unknown status keeps its raw name and falls back to the To Do column', async () => {
    const runQuery = vi.fn(
      async (): Promise<JiraFetchResult> => ({
        ok: true,
        issues: [remote('A-1', { rawStatus: 'Zcela Nový Stav' })],
        partial: false
      })
    )
    const { engine } = makeEngine({ runQuery })
    const board = await engine.refresh('global')
    expect(board.issues[0].column).toBe('todo')
    expect(board.issues[0].rawStatus).toBe('Zcela Nový Stav')
  })
})

describe('zero Claude by construction', () => {
  test('the sync engine and client sources import no spawn, PTY, or hidden-session module', () => {
    for (const file of ['jiraSyncEngine.ts', 'jiraClient.ts', 'jiraSession.ts']) {
      const source = readFileSync(join(__dirname, file), 'utf8')
      const imports = source
        .split('\n')
        .filter((line) => /^\s*import\b|\brequire\s*\(/.test(line))
        .join('\n')
      expect(imports).not.toMatch(/child_process|node-pty|pty\//i)
      expect(imports).not.toMatch(/jiraFetch|jiraSpawn|jiraReport/)
    }
  })
})
