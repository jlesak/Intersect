import { beforeEach, describe, expect, test } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { NewWorkItemRef } from '@common/domain'
import { createTabRepo, type TabRepo } from './tabRepo'
import { createWorkItemRefRepo, type WorkItemRefRepo } from './workItemRefRepo'
import { createWorkspaceRepo } from './workspaceRepo'
import { makeTestDb, makeTestDeps } from './testkit'

const jiraRef = (key = 'FID-1'): NewWorkItemRef => ({
  source: 'jira',
  externalKey: key,
  projectId: null,
  snapshot: { key, title: `Summary of ${key}`, type: 'issue' }
})

describe('workItemRefRepo', () => {
  let db: DatabaseSync
  let tabs: TabRepo
  let refs: WorkItemRefRepo
  let workspaces: ReturnType<typeof createWorkspaceRepo>
  let wsId: string
  let tabId: string

  beforeEach(() => {
    db = makeTestDb()
    const deps = makeTestDeps()
    workspaces = createWorkspaceRepo(db, deps)
    tabs = createTabRepo(db, deps)
    refs = createWorkItemRefRepo(db, deps)
    wsId = workspaces.create('/a').id
    tabId = tabs.create(wsId, 'claude').id
  })

  test('set on a fresh tab stores the ref and records an assign event', () => {
    const stored = refs.set(tabId, jiraRef())
    expect(stored.tabId).toBe(tabId)
    expect(stored.source).toBe('jira')
    expect(stored.snapshot).toEqual({ key: 'FID-1', title: 'Summary of FID-1', type: 'issue' })
    expect(refs.get(tabId)).toEqual(stored)
    expect(refs.history(tabId).map((e) => e.action)).toEqual(['assign'])
  })

  test('set on a tab that already has a ref replaces it and records a change event', () => {
    refs.set(tabId, jiraRef('FID-1'))
    refs.set(tabId, jiraRef('FID-2'))
    expect(refs.get(tabId)?.externalKey).toBe('FID-2')
    // Still exactly one row per tab - the primary key enforces at-most-one.
    const count = (
      db.prepare('SELECT count(*) AS c FROM work_item_refs WHERE tab_id = ?').get(tabId) as {
        c: number
      }
    ).c
    expect(count).toBe(1)
    const history = refs.history(tabId)
    expect(history.map((e) => e.action)).toEqual(['assign', 'change'])
    expect(history[1].externalKey).toBe('FID-2')
  })

  test('clear removes the ref and records a clear event carrying the cleared identity', () => {
    refs.set(tabId, jiraRef('FID-9'))
    refs.clear(tabId)
    expect(refs.get(tabId)).toBeUndefined()
    const history = refs.history(tabId)
    expect(history.map((e) => e.action)).toEqual(['assign', 'clear'])
    expect(history[1].externalKey).toBe('FID-9')
    expect(history[1].snapshotKey).toBe('FID-9')
  })

  test('clear on a tab without a ref is a no-op that records nothing', () => {
    refs.clear(tabId)
    expect(refs.history(tabId)).toEqual([])
  })

  test('a second tab cannot share the first tab\'s ref row (one ref per session)', () => {
    const other = tabs.create(wsId, 'shell').id
    refs.set(tabId, jiraRef('FID-1'))
    refs.set(other, jiraRef('FID-1'))
    // Same work item on two tabs is two independent refs, one per tab.
    expect(refs.listForWorkspace(wsId)).toHaveLength(2)
  })

  test('listForWorkspace returns only the workspace\'s refs in tab order', () => {
    const otherWs = workspaces.create('/b').id
    const otherTab = tabs.create(otherWs, 'claude').id
    const second = tabs.create(wsId, 'shell').id
    refs.set(second, jiraRef('FID-2'))
    refs.set(tabId, jiraRef('FID-1'))
    refs.set(otherTab, jiraRef('FID-3'))
    expect(refs.listForWorkspace(wsId).map((r) => r.externalKey)).toEqual(['FID-1', 'FID-2'])
  })

  test('deleting the tab cascades the ref away but the history survives', () => {
    refs.set(tabId, jiraRef('FID-1'))
    tabs.remove(tabId)
    expect(refs.get(tabId)).toBeUndefined()
    expect(refs.history(tabId).map((e) => e.action)).toEqual(['assign'])
  })

  test('a ref with an unknown source value is rejected by the schema', () => {
    expect(() =>
      refs.set(tabId, { ...jiraRef(), source: 'github' as never })
    ).toThrow()
    expect(refs.get(tabId)).toBeUndefined()
    // The rejected write also left no orphan history entry.
    expect(refs.history(tabId)).toEqual([])
  })

  test('supports all three sources through the one polymorphic shape', () => {
    const t2 = tabs.create(wsId, 'claude').id
    const t3 = tabs.create(wsId, 'claude').id
    refs.set(tabId, jiraRef())
    refs.set(t2, {
      source: 'todo',
      externalKey: 'task-1',
      projectId: null,
      snapshot: { key: 'TODO', title: 'Water plants', type: 'task' }
    })
    refs.set(t3, {
      source: 'ado-pr',
      externalKey: 'repo:12',
      projectId: null,
      snapshot: { key: '!12', title: 'Fix build', type: 'pull-request' }
    })
    expect(refs.listForWorkspace(wsId).map((r) => r.source)).toEqual(['jira', 'todo', 'ado-pr'])
  })
})
