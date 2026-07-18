import { beforeEach, describe, expect, test } from 'vitest'
import type { IpcApi } from '@common/ipc'
import type { JiraIssueSnapshot, NewWorkItemRef, PullRequest } from '@common/domain'
import { createJiraCacheRepo, type JiraCacheRepo } from '../db/jiraCacheRepo'
import { createPrCacheRepo, type PrCacheRepo } from '../db/prCacheRepo'
import { createProjectOverrideRepo } from '../db/projectOverrideRepo'
import { createTodoRepo, type TodoRepo } from '../db/todoRepo'
import { makeTestDeps } from '../db/testkit'
import { createWorkItemsHandlers } from './workItems.ipc'
import { makeHandlerContext, type HandlerContext } from './handlerTestkit'

const issue = (key: string, summary = `Issue ${key}`): JiraIssueSnapshot => ({
  key,
  url: `https://jira/browse/${key}`,
  summary,
  column: 'todo',
  priority: null,
  updatedAt: 1,
  description: null,
  rawStatus: 'To Do',
  rawPriority: null,
  assignee: null,
  epicKey: null,
  epicSummary: null,
  estimateSeconds: null,
  components: [],
  fetchedAt: 1,
  absent: false
})

const pullRequest = (prId: number, title: string, repositoryName = 'spot-backend'): PullRequest => ({
  prId,
  repositoryId: 'repo-guid',
  repositoryName,
  projectId: 'ado-project',
  title,
  authorId: 'a',
  authorName: 'A',
  createdAt: 1,
  status: 'active',
  sourceRefName: 'refs/heads/f',
  targetRefName: 'refs/heads/main',
  sourceCommitId: '',
  targetCommitId: '',
  url: '',
  role: 'author',
  myVote: null,
  myReviewerId: null,
  reviewers: [],
  newChangesSinceMyReview: false,
  activeThreadCount: 0
})

const jiraRef = (key: string): NewWorkItemRef => ({
  source: 'jira',
  externalKey: key,
  projectId: null,
  snapshot: { key, title: `Issue ${key}`, type: 'issue' }
})

describe('workItems handlers', () => {
  let ctx: HandlerContext
  let handlers: IpcApi['workItems']
  let todos: TodoRepo
  let prCache: PrCacheRepo
  let jiraCache: JiraCacheRepo
  let wsId: string
  let tabId: string

  beforeEach(() => {
    ctx = makeHandlerContext()
    const deps = makeTestDeps()
    todos = createTodoRepo(ctx.db, deps)
    prCache = createPrCacheRepo(ctx.db, deps)
    jiraCache = createJiraCacheRepo(ctx.db)
    handlers = createWorkItemsHandlers({
      refs: ctx.workItemRefs,
      workspaces: ctx.workspaces,
      projects: ctx.projects,
      overrides: createProjectOverrideRepo(ctx.db, deps),
      todos,
      prCache,
      jiraCache
    })
    wsId = ctx.workspaces.create('/a').id
    tabId = ctx.tabs.create(wsId, 'claude').id
  })

  test('setPrimary + listForWorkspace round-trip with a linked state', async () => {
    jiraCache.putSuccess('global', [issue('FID-1')], 1, false)
    const set = await handlers.setPrimary(tabId, jiraRef('FID-1'))
    expect(set.state).toBe('linked')
    const listed = await handlers.listForWorkspace(wsId)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ tabId, externalKey: 'FID-1', state: 'linked' })
  })

  test('a jira issue absent from every cache reads stale; one never cached reads missing', async () => {
    jiraCache.putSuccess('global', [issue('FID-1')], 1, false)
    await handlers.setPrimary(tabId, jiraRef('FID-1'))
    // The next sync no longer returns the issue - it is flagged absent, never deleted.
    jiraCache.putSuccess('global', [], 2, false)
    expect((await handlers.listForWorkspace(wsId))[0].state).toBe('stale')

    const other = ctx.tabs.create(wsId, 'claude').id
    await handlers.setPrimary(other, jiraRef('GHOST-1'))
    const states = new Map(
      (await handlers.listForWorkspace(wsId)).map((r) => [r.tabId, r.state])
    )
    expect(states.get(other)).toBe('missing')
    // Neither state deleted anything: both refs and their history are intact.
    expect(ctx.workItemRefs.get(tabId)).toBeDefined()
    expect(ctx.workItemRefs.history(tabId)).toHaveLength(1)
  })

  test('a done todo stays linked; a hard-deleted one reads missing without losing the ref', async () => {
    const task = todos.create('Water plants', null)
    await handlers.setPrimary(tabId, {
      source: 'todo',
      externalKey: task.id,
      projectId: null,
      snapshot: { key: 'TODO', title: task.text, type: 'task' }
    })
    todos.setDone(task.id, true)
    expect((await handlers.listForWorkspace(wsId))[0].state).toBe('linked')
    todos.remove(task.id)
    const ref = (await handlers.listForWorkspace(wsId))[0]
    expect(ref.state).toBe('missing')
    expect(ref.snapshot.title).toBe('Water plants')
  })

  test('a PR gone from the replace-on-sync cache reads stale, never missing', async () => {
    prCache.replaceAll([pullRequest(12, 'Fix build')])
    await handlers.setPrimary(tabId, {
      source: 'ado-pr',
      externalKey: 'repo-guid:12',
      projectId: null,
      snapshot: { key: '!12', title: 'Fix build', type: 'pull-request' }
    })
    expect((await handlers.listForWorkspace(wsId))[0].state).toBe('linked')
    prCache.replaceAll([])
    expect((await handlers.listForWorkspace(wsId))[0].state).toBe('stale')
  })

  test('assign, change, clear all round-trip and each mutation lands in the history', async () => {
    await handlers.setPrimary(tabId, jiraRef('FID-1'))
    await handlers.setPrimary(tabId, jiraRef('FID-2'))
    await handlers.clearPrimary(tabId)
    expect(await handlers.listForWorkspace(wsId)).toEqual([])
    expect((await handlers.history(tabId)).map((e) => e.action)).toEqual([
      'assign',
      'change',
      'clear'
    ])
  })

  test('syncing the jira and PR caches never mutates an explicit primary ref', async () => {
    await handlers.setPrimary(tabId, jiraRef('FID-1'))
    const before = ctx.workItemRefs.get(tabId)
    // Cache syncs are the only background writers near work items; a same-branch PR or a fresh
    // Jira fetch must stay a secondary signal that cannot overwrite the explicit primary ref.
    jiraCache.putSuccess('global', [issue('FID-9', 'Something else')], 5, false)
    prCache.replaceAll([pullRequest(99, 'Unrelated PR')])
    expect(ctx.workItemRefs.get(tabId)).toEqual(before)
    expect((await handlers.history(tabId)).map((e) => e.action)).toEqual(['assign'])
  })

  test('searchCandidates groups by source, matches key+title, and prebuilds override-aware refs', async () => {
    const p1 = ctx.projects.create('SPOT', '/repos/spot')
    ctx.projects.update(p1.id, { jiraJql: 'project = FID', adoRepositories: ['spot-backend'] })
    jiraCache.putSuccess('global', [issue('FID-1', 'Fix login'), issue('OTHER-1', 'Elsewhere')], 1, false)
    todos.create('Fix the fence', null)
    prCache.replaceAll([pullRequest(12, 'Fix build')])

    const groups = await handlers.searchCandidates('fix', wsId)
    expect(groups.map((g) => g.source)).toEqual(['jira', 'todo', 'ado-pr'])
    expect(groups[0].candidates.map((c) => c.externalKey)).toEqual(['FID-1'])
    expect(groups[0].candidates[0].projectId).toBe(p1.id)
    expect(groups[1].candidates[0].projectId).toBeNull()
    expect(groups[2].candidates[0].projectId).toBe(p1.id)

    // A manual override redirects the prebuilt ref's project.
    createProjectOverrideRepo(ctx.db, makeTestDeps()).set('jira', 'FID-1', null)
    const overridden = await handlers.searchCandidates('FID-1', wsId)
    expect(overridden[0].candidates[0].projectId).toBeNull()
  })

  test('searchCandidates ranks the workspace project\'s items first', async () => {
    const p1 = ctx.projects.create('SPOT', '/repos/spot')
    ctx.projects.update(p1.id, { jiraJql: 'project = FID' })
    const projectWs = ctx.workspaces.create('/repos/spot', undefined, p1.id)
    expect(projectWs.projectId).toBe(p1.id)
    jiraCache.putSuccess('global', [issue('OTHER-1'), issue('FID-1')], 1, false)

    const groups = await handlers.searchCandidates('', projectWs.id)
    expect(groups[0].candidates.map((c) => c.externalKey)).toEqual(['FID-1', 'OTHER-1'])

    // Without a workspace the cache order stands.
    const unranked = await handlers.searchCandidates('', null)
    expect(unranked[0].candidates.map((c) => c.externalKey)).toEqual(['OTHER-1', 'FID-1'])
  })
})
