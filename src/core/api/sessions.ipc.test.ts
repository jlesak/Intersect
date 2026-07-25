import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, test, vi } from 'vitest'
import type { SessionSummary, SessionTranscript } from '@common/domain'
import { Channel, makeSessionId } from '@common/ipc'
import type { SessionIndex } from '../sessions/sessionIndex'
import type { SessionLifecycleService } from '../hooks/sessionLifecycleService'
import type { LifecycleState } from '../hooks/lifecycle'
import { createTabRepo, type TabRepo } from '../db/tabRepo'
import { createWorkspaceRepo, type WorkspaceRepo } from '../db/workspaceRepo'
import { makeTestDb, makeTestDeps } from '../db/testkit'
import { createSessionHandlers, sessionsWireRoutes, type SessionHandlerDeps } from './sessions.ipc'

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's1',
  filePath: '/p/a/s1.jsonl',
  cwd: '/repo',
  folderName: 'repo',
  title: 'A session',
  gitBranch: null,
  firstTimestamp: 1,
  lastTimestamp: 2,
  durationMs: 1,
  activeDurationMs: 1,
  messageCount: 2,
  userPrompts: ['hi'],
  ...over
})

const transcript: SessionTranscript = { id: 's1', title: 'A session', cwd: '/repo', entries: [] }

function makeIndex(over: Partial<SessionIndex> = {}): SessionIndex {
  return {
    list: vi.fn(async () => [summary()]),
    refresh: vi.fn(async () => [summary({ id: 's2' })]),
    getTranscript: vi.fn(async () => transcript),
    ...over
  }
}

/** A lifecycle stub exposing just the live list the handlers read. */
function makeLifecycle(live: { sessionId: string; cwd: string; state: LifecycleState }[] = []): SessionLifecycleService {
  return {
    onSpawn: vi.fn(),
    onHookEvent: vi.fn(),
    onUserInput: vi.fn(),
    onPtyExit: vi.fn(),
    isHookHealthy: vi.fn(() => false),
    listLive: () => live
  }
}

interface Harness {
  deps: SessionHandlerDeps
  db: DatabaseSync
  tabs: TabRepo
  workspaces: WorkspaceRepo
}

function makeHarness(
  live: { sessionId: string; cwd: string; state: LifecycleState }[] = [],
  index: SessionIndex = makeIndex()
): Harness {
  const db = makeTestDb()
  const repoDeps = makeTestDeps()
  const workspaces = createWorkspaceRepo(db, repoDeps)
  const tabs = createTabRepo(db, repoDeps)
  const deps: SessionHandlerDeps = { index, lifecycle: makeLifecycle(live), tabs, workspaces, db }
  return { deps, db, tabs, workspaces }
}

describe('session handlers', () => {
  test('list delegates to the index', async () => {
    const { deps } = makeHarness()
    const h = createSessionHandlers(deps)
    expect((await h.list()).map((s) => s.id)).toEqual(['s1'])
    expect(deps.index.list).toHaveBeenCalledOnce()
  })

  test('refresh delegates to the index', async () => {
    const { deps } = makeHarness()
    const h = createSessionHandlers(deps)
    expect((await h.refresh()).map((s) => s.id)).toEqual(['s2'])
    expect(deps.index.refresh).toHaveBeenCalledOnce()
  })

  test('getTranscript delegates with the id', async () => {
    const { deps } = makeHarness()
    const h = createSessionHandlers(deps)
    expect(await h.getTranscript('s1')).toBe(transcript)
    expect(deps.index.getTranscript).toHaveBeenCalledWith('s1')
  })

  test('wraps a thrown error as a message-only Error', async () => {
    const { deps } = makeHarness(
      [],
      makeIndex({
        getTranscript: vi.fn(async () => {
          throw new Error('Unknown session: nope')
        })
      })
    )
    const h = createSessionHandlers(deps)
    await expect(h.getTranscript('nope')).rejects.toThrow(/Unknown session: nope/)
  })

  test('wraps a non-Error throw into an Error with a message', async () => {
    const { deps } = makeHarness(
      [],
      makeIndex({
        list: vi.fn(async () => {
          throw 'boom'
        })
      })
    )
    const h = createSessionHandlers(deps)
    await expect(h.list()).rejects.toThrow(/boom/)
  })

  test('listLive joins the tracked live sessions with the tab and workspace names', async () => {
    const { deps, tabs, workspaces } = makeHarness([])
    const ws = workspaces.create('/repo', 'My repo')
    const tab = tabs.create(ws.id, 'claude', 'Feature X')
    const sessionId = makeSessionId(ws.id, tab.id)
    deps.lifecycle = makeLifecycle([{ sessionId, cwd: '/repo', state: 'working' }])

    const h = createSessionHandlers(deps)
    expect(await h.listLive()).toEqual([
      { sessionId, tabId: tab.id, title: 'Feature X', workspace: 'My repo', cwd: '/repo' }
    ])
  })

  test('listLive falls back to defaults when the tab or workspace is gone', async () => {
    const { deps } = makeHarness([{ sessionId: 'ghostws:ghosttab', cwd: '/x', state: 'working' }])
    const h = createSessionHandlers(deps)
    expect(await h.listLive()).toEqual([
      { sessionId: 'ghostws:ghosttab', tabId: 'ghosttab', title: 'Claude Code', workspace: '/x', cwd: '/x' }
    ])
  })

  test('clearSuspended clears the tab marker and audits a resume', async () => {
    const { deps, tabs, workspaces } = makeHarness([])
    const ws = workspaces.create('/repo')
    const tab = tabs.create(ws.id, 'claude')
    tabs.setSuspended(tab.id, 'app-quit-suspend')
    expect(tabs.getById(tab.id)?.sessionStatus).toBe('suspended')

    const h = createSessionHandlers(deps)
    await h.clearSuspended(tab.id)

    expect(tabs.getById(tab.id)?.sessionStatus).toBeNull()
    expect(tabs.history(tab.id).map((e) => e.action)).toEqual(['suspend', 'resume'])
  })
})

describe('sessionsWireRoutes', () => {
  test('binds every request/response channel to a handler', async () => {
    const { deps } = makeHarness()
    const h = createSessionHandlers(deps)
    const routes = sessionsWireRoutes(h)
    const call = (channel: string, ...args: unknown[]): unknown =>
      (routes[channel] as (...a: unknown[]) => unknown)(...args)

    expect(Object.keys(routes).sort()).toEqual(
      [
        Channel.sessionsList,
        Channel.sessionsRefresh,
        Channel.sessionsGetTranscript,
        Channel.sessionsListLive,
        Channel.sessionsClearSuspended
      ].sort()
    )

    const listResult = (await call(Channel.sessionsList)) as SessionSummary[]
    expect(listResult.map((s) => s.id)).toEqual(['s1'])

    const t = await call(Channel.sessionsGetTranscript, 's1')
    expect(t).toBe(transcript)
  })
})
