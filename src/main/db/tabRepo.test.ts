import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, test } from 'vitest'
import { createTabRepo, type TabRepo } from './tabRepo'
import { createWorkspaceRepo, type WorkspaceRepo } from './workspaceRepo'
import { makeTestDb, makeTestDeps } from './testkit'

describe('tabRepo', () => {
  let db: DatabaseSync
  let tabs: TabRepo
  let workspaces: WorkspaceRepo
  let wsId: string

  beforeEach(() => {
    db = makeTestDb()
    const deps = makeTestDeps()
    workspaces = createWorkspaceRepo(db, deps)
    tabs = createTabRepo(db, deps)
    wsId = workspaces.create('/a').id
  })

  test('create defaults the title from the preset and starts unplaced', () => {
    const shell = tabs.create(wsId, 'shell')
    expect(shell.title).toBe('Shell')
    expect(shell.preset).toBe('shell')
    expect(shell.paneSlot).toBeNull()
    expect(shell.workspaceId).toBe(wsId)
    expect(tabs.create(wsId, 'claude').title).toBe('Claude')
  })

  test('listByWorkspace returns tabs ordered by sortOrder', () => {
    tabs.create(wsId, 'shell')
    tabs.create(wsId, 'claude')
    tabs.create(wsId, 'shell')
    expect(tabs.listByWorkspace(wsId).map((t) => t.sortOrder)).toEqual([0, 1, 2])
  })

  test('listByWorkspace is scoped to one workspace', () => {
    const other = workspaces.create('/b').id
    tabs.create(wsId, 'shell')
    tabs.create(other, 'shell')
    expect(tabs.listByWorkspace(wsId)).toHaveLength(1)
    expect(tabs.listByWorkspace(other)).toHaveLength(1)
  })

  test('rename updates the title', () => {
    const t = tabs.create(wsId, 'shell')
    expect(tabs.rename(t.id, 'build').title).toBe('build')
    expect(tabs.getById(t.id)?.title).toBe('build')
  })

  test('remove deletes the tab', () => {
    const t = tabs.create(wsId, 'shell')
    tabs.remove(t.id)
    expect(tabs.getById(t.id)).toBeUndefined()
  })

  test('reorder rewrites sortOrder to match the given order and persists it', () => {
    const a = tabs.create(wsId, 'shell')
    const b = tabs.create(wsId, 'claude')
    const c = tabs.create(wsId, 'shell')
    const reordered = tabs.reorder(wsId, [c.id, a.id, b.id])
    expect(reordered.map((t) => t.id)).toEqual([c.id, a.id, b.id])
    expect(reordered.map((t) => t.sortOrder)).toEqual([0, 1, 2])
    expect(tabs.listByWorkspace(wsId).map((t) => t.id)).toEqual([c.id, a.id, b.id])
  })

  test('setPaneSlot assigns and clears a pane slot', () => {
    const t = tabs.create(wsId, 'shell')
    expect(tabs.setPaneSlot(t.id, 2).paneSlot).toBe(2)
    expect(tabs.setPaneSlot(t.id, null).paneSlot).toBeNull()
  })

  test('setPaneSlots batch-updates assignments in one transaction', () => {
    const a = tabs.create(wsId, 'shell')
    const b = tabs.create(wsId, 'claude')
    tabs.setPaneSlots([
      { id: a.id, paneSlot: 0 },
      { id: b.id, paneSlot: 1 }
    ])
    const list = tabs.listByWorkspace(wsId)
    expect(list.find((t) => t.id === a.id)?.paneSlot).toBe(0)
    expect(list.find((t) => t.id === b.id)?.paneSlot).toBe(1)
  })

  test('clearPaneSlot frees the slot for all workspace tabs except the given one', () => {
    const a = tabs.create(wsId, 'shell')
    const b = tabs.create(wsId, 'shell')
    tabs.setPaneSlot(a.id, 0)
    tabs.setPaneSlot(b.id, 0)
    tabs.clearPaneSlot(wsId, 0, b.id)
    expect(tabs.getById(a.id)?.paneSlot).toBeNull()
    expect(tabs.getById(b.id)?.paneSlot).toBe(0)
  })

  test('rename throws for a missing tab', () => {
    expect(() => tabs.rename('missing', 'x')).toThrow(/not found/i)
  })
})
