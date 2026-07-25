import { describe, expect, test } from 'vitest'
import type { Project, SessionSummary, Workspace } from '@common/domain'
import type { StoredWorkItemRef } from '../db/workItemRefRepo'
import { createAgentRuntimeRepo } from '../db/agentRuntimeRepo'
import { makeTestDb } from '../db/testkit'
import type { ProjectPathDeps } from '../projects/resolveProject'
import { createAgentRuntimeService, type AgentRuntimeDeps } from './agentRuntimeService'

const MIN = 60 * 1000

function at(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
}

const idPathDeps: ProjectPathDeps = {
  canonicalize: (p) => p,
  worktreeParentRoot: () => null
}

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws1',
    name: 'W',
    folderPath: '/repo',
    layout: 'single',
    activeTabId: null,
    sortOrder: 0,
    projectId: null,
    projectSource: 'auto',
    ...over
  }
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'P',
    sortOrder: 0,
    archived: false,
    repoPaths: ['/repo'],
    jiraJql: null,
    jiraBoardUrl: null,
    adoRepositories: [],
    togglProjectId: null,
    ...over
  }
}

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'uuid-1',
    filePath: '/x.jsonl',
    cwd: '/repo',
    folderName: 'repo',
    title: 'T',
    gitBranch: null,
    firstTimestamp: at(2026, 7, 6, 10, 0),
    lastTimestamp: at(2026, 7, 6, 12, 0),
    durationMs: 60 * MIN,
    activeDurationMs: 60 * MIN,
    messageCount: 2,
    userPrompts: [],
    ...over
  }
}

/**
 * A test harness with a controllable ping source and pluggable attribution edges. `pings` maps a
 * session id to explicit `receivedAt` values (the repo append path uses a clock, so activity is
 * injected directly here). Everything else defaults to empty.
 */
function makeHarness(
  opts: {
    pings?: Record<string, number[]>
    refs?: Record<string, StoredWorkItemRef>
    workspaces?: Workspace[]
    tabs?: Record<string, { id: string; resumeSessionId: string | null }[]>
    projects?: Project[]
    sessions?: SessionSummary[]
  } = {}
) {
  const pings = opts.pings ?? {}
  let clock = 1000
  const db = makeTestDb()
  // Seed every project id the evidence may reference so the FK to projects holds - in production
  // these always point at a live project (both refs and workspaces null their project on delete).
  const projectIds = new Set<string>()
  for (const p of opts.projects ?? []) projectIds.add(p.id)
  for (const ref of Object.values(opts.refs ?? {})) if (ref.projectId) projectIds.add(ref.projectId)
  for (const ws of opts.workspaces ?? []) if (ws.projectId) projectIds.add(ws.projectId)
  const insertProject = db.prepare(
    'INSERT INTO projects (id,name,sort_order,archived,created_at) VALUES (?,?,?,0,?)'
  )
  let order = 0
  for (const id of projectIds) insertProject.run(id, id, order++, 1)
  const repo = createAgentRuntimeRepo(db)
  const deps: AgentRuntimeDeps = {
    hookEvents: {
      listBySession: (id) =>
        (pings[id] ?? []).map((receivedAt) => ({
          sessionId: id,
          eventName: 'ping',
          payload: {},
          receivedAt
        })),
      listSessions: () => Object.keys(pings)
    },
    workItemRefs: { get: (tabId) => (opts.refs ?? {})[tabId] },
    workspaces: {
      getById: (id) => (opts.workspaces ?? []).find((w) => w.id === id),
      list: () => opts.workspaces ?? []
    },
    tabs: { listByWorkspace: (id) => (opts.tabs ?? {})[id] ?? [] },
    projects: { list: () => opts.projects ?? [] },
    sessions: { list: async () => opts.sessions ?? [] },
    pathDeps: idPathDeps,
    repo,
    now: () => ++clock
  }
  return { service: createAgentRuntimeService(deps), repo }
}

describe('agentRuntimeService.recomputeSession', () => {
  test('turns pings into high-confidence hook evidence on the right day', () => {
    const t = at(2026, 7, 6, 10, 0)
    const { service } = makeHarness({ pings: { 'ws1:tab1': [t, t + 3 * MIN, t + 8 * MIN] } })
    service.recomputeSession('ws1:tab1')
    const rows = service.getForSession('ws1:tab1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      localDate: '2026-07-06',
      minutes: 8,
      source: 'hook',
      confidence: 'high',
      externalId: 'hook:ws1:tab1:2026-07-06'
    })
  })

  test('a 15-minute gap adds at most 10 minutes', () => {
    const t = at(2026, 7, 6, 10, 0)
    const { service } = makeHarness({ pings: { 'ws1:tab1': [t, t + 15 * MIN] } })
    service.recomputeSession('ws1:tab1')
    expect(service.getForSession('ws1:tab1')[0].minutes).toBe(10)
  })

  test('a session spanning midnight splits into the correct local days', () => {
    const late = at(2026, 7, 6, 23, 58)
    const early = at(2026, 7, 7, 0, 3)
    const { service } = makeHarness({ pings: { 'ws1:tab1': [late, early, early + 4 * MIN] } })
    service.recomputeSession('ws1:tab1')
    const rows = service.getForSession('ws1:tab1')
    expect(rows.map((r) => `${r.localDate}=${r.minutes}`)).toEqual(['2026-07-06=5', '2026-07-07=4'])
  })

  test('repeated recompute produces no duplicate rows (idempotent)', () => {
    const t = at(2026, 7, 6, 10, 0)
    const { service } = makeHarness({ pings: { 'ws1:tab1': [t, t + 5 * MIN] } })
    service.recomputeSession('ws1:tab1')
    service.recomputeSession('ws1:tab1')
    expect(service.getForSession('ws1:tab1')).toHaveLength(1)
    expect(service.getForSession('ws1:tab1')[0].minutes).toBe(5)
  })

  test('later events extend the same row (accrual on re-fire)', () => {
    const t = at(2026, 7, 6, 10, 0)
    const pings: Record<string, number[]> = { 'ws1:tab1': [t, t + 5 * MIN] }
    const { service } = makeHarness({ pings })
    service.recomputeSession('ws1:tab1')
    expect(service.getForSession('ws1:tab1')[0].minutes).toBe(5)
    // A later burst on the same instance: +20m gap (capped to 10) +4m = 5+10+4 = 19.
    pings['ws1:tab1'] = [t, t + 5 * MIN, t + 25 * MIN, t + 29 * MIN]
    service.recomputeSession('ws1:tab1')
    expect(service.getForSession('ws1:tab1')).toHaveLength(1)
    expect(service.getForSession('ws1:tab1')[0].minutes).toBe(19)
  })

  test('an explicit primary ref wins over the workspace project and sets the work item', () => {
    const t = at(2026, 7, 6, 10, 0)
    const ref: StoredWorkItemRef = {
      tabId: 'tab1',
      source: 'jira',
      externalKey: 'FID-1',
      projectId: 'p-ref',
      snapshot: { key: 'FID-1', title: 'S', type: 'issue' },
      assignedAt: 1
    }
    const { service } = makeHarness({
      pings: { 'ws1:tab1': [t, t + 5 * MIN] },
      refs: { tab1: ref },
      workspaces: [workspace({ id: 'ws1', projectId: 'p-workspace' })]
    })
    service.recomputeSession('ws1:tab1')
    expect(service.getForSession('ws1:tab1')[0]).toMatchObject({
      projectId: 'p-ref',
      workItemSource: 'jira',
      workItemKey: 'FID-1'
    })
  })

  test('without a ref the session inherits its workspace project', () => {
    const t = at(2026, 7, 6, 10, 0)
    const { service } = makeHarness({
      pings: { 'ws1:tab1': [t, t + 5 * MIN] },
      workspaces: [workspace({ id: 'ws1', projectId: 'p-workspace' })]
    })
    service.recomputeSession('ws1:tab1')
    expect(service.getForSession('ws1:tab1')[0]).toMatchObject({
      projectId: 'p-workspace',
      workItemSource: null,
      workItemKey: null
    })
  })

  test('unknown context stays unassigned (null) and creates no entity', () => {
    const t = at(2026, 7, 6, 10, 0)
    const { service } = makeHarness({ pings: { 'ws1:tab1': [t, t + 5 * MIN] } })
    service.recomputeSession('ws1:tab1')
    expect(service.getForSession('ws1:tab1')[0].projectId).toBeNull()
  })
})

describe('agentRuntimeService week aggregation', () => {
  test('three parallel one-hour agents sum to three agent-hours on the day', () => {
    const t = at(2026, 7, 6, 9, 0)
    // Each session pings once a minute for 60 minutes -> ~60 min of capped active time each.
    const hourOf = (): number[] => Array.from({ length: 61 }, (_, i) => t + i * MIN)
    const { service } = makeHarness({
      pings: { 'ws1:a': hourOf(), 'ws1:b': hourOf(), 'ws1:c': hourOf() }
    })
    service.recomputeSession('ws1:a')
    service.recomputeSession('ws1:b')
    service.recomputeSession('ws1:c')
    const week = service.getWeek('2026-07-06')
    expect(week).toHaveLength(1)
    expect(week[0]).toMatchObject({ localDate: '2026-07-06', minutes: 180, agents: 3 })
  })

  test('getForProject rolls up only that project', () => {
    const t = at(2026, 7, 6, 9, 0)
    const { service } = makeHarness({
      pings: { 'ws1:a': [t, t + 30 * MIN, t + 40 * MIN], 'ws1:b': [t, t + 10 * MIN] },
      refs: {
        a: {
          tabId: 'a',
          source: 'jira',
          externalKey: 'K',
          projectId: 'p1',
          snapshot: { key: 'K', title: 'T', type: 'issue' },
          assignedAt: 1
        }
      },
      workspaces: [workspace({ id: 'ws1', projectId: 'p2' })]
    })
    service.recomputeSession('ws1:a')
    service.recomputeSession('ws1:b')
    const p1 = service.getForProject('p1', '2026-07-06')
    expect(p1).toHaveLength(1)
    expect(p1[0].agents).toBe(1)
  })
})

describe('agentRuntimeService.recomputeAll JSONL fallback', () => {
  test('emits low-confidence evidence for a transcript hooks never covered', async () => {
    const { service } = makeHarness({
      projects: [project()],
      sessions: [summary({ id: 'uuid-1', durationMs: 60 * MIN })]
    })
    await service.recomputeAll()
    const rows = service.getForSession('jsonl:uuid-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source: 'jsonl',
      confidence: 'low',
      projectId: 'p1',
      // One coarse span, capped like a single gap at 10 minutes.
      minutes: 10
    })
  })

  test('a transcript covered by a hook session is excluded (no double count)', async () => {
    const t = at(2026, 7, 6, 10, 0)
    const { service } = makeHarness({
      pings: { 'ws1:tab1': [t, t + 5 * MIN] },
      tabs: { ws1: [{ id: 'tab1', resumeSessionId: 'uuid-1' }] },
      workspaces: [workspace({ id: 'ws1' })],
      projects: [project()],
      sessions: [summary({ id: 'uuid-1' })]
    })
    await service.recomputeAll()
    expect(service.getForSession('jsonl:uuid-1')).toEqual([])
    // The hook session itself is measured.
    expect(service.getForSession('ws1:tab1')).toHaveLength(1)
  })

  test('a transcript whose tab has no hook activity is NOT covered and falls back', async () => {
    const { service } = makeHarness({
      // The tab resumes uuid-1 but its instance session posted no hook events.
      tabs: { ws1: [{ id: 'tab1', resumeSessionId: 'uuid-1' }] },
      workspaces: [workspace({ id: 'ws1' })],
      projects: [project()],
      sessions: [summary({ id: 'uuid-1' })]
    })
    await service.recomputeAll()
    expect(service.getForSession('jsonl:uuid-1')).toHaveLength(1)
  })
})
