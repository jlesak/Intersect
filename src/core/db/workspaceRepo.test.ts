import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, test } from 'vitest'
import { createWorkspaceRepo, type WorkspaceRepo } from './workspaceRepo'
import { makeTestDb, makeTestDeps } from './testkit'

describe('workspaceRepo', () => {
  let db: DatabaseSync
  let repo: WorkspaceRepo

  beforeEach(() => {
    db = makeTestDb()
    repo = createWorkspaceRepo(db, makeTestDeps())
  })

  test('create defaults the name to the folder basename', () => {
    const ws = repo.create('/Users/me/projects/dashboard')
    expect(ws.name).toBe('dashboard')
    expect(ws.folderPath).toBe('/Users/me/projects/dashboard')
    expect(ws.layout).toBe('single')
    expect(ws.activeTabId).toBeNull()
    expect(ws.id).toBe('id-1')
  })

  test('create uses an explicit name when provided', () => {
    expect(repo.create('/tmp/foo', 'My Workspace').name).toBe('My Workspace')
  })

  test('list returns workspaces ordered by sortOrder with contiguous order', () => {
    repo.create('/a')
    repo.create('/b')
    repo.create('/c')
    expect(repo.list().map((w) => w.folderPath)).toEqual(['/a', '/b', '/c'])
    expect(repo.list().map((w) => w.sortOrder)).toEqual([0, 1, 2])
  })

  test('getById returns the workspace or undefined', () => {
    const ws = repo.create('/a')
    expect(repo.getById(ws.id)?.folderPath).toBe('/a')
    expect(repo.getById('missing')).toBeUndefined()
  })

  test('rename updates the name and returns the fresh row', () => {
    const ws = repo.create('/a')
    expect(repo.rename(ws.id, 'Renamed').name).toBe('Renamed')
    expect(repo.getById(ws.id)?.name).toBe('Renamed')
  })

  test('remove deletes the workspace (app state only)', () => {
    const ws = repo.create('/a')
    repo.remove(ws.id)
    expect(repo.getById(ws.id)).toBeUndefined()
    expect(repo.list()).toEqual([])
  })

  test('setLayout persists the chosen layout', () => {
    const ws = repo.create('/a')
    expect(repo.setLayout(ws.id, 'grid').layout).toBe('grid')
    expect(repo.getById(ws.id)?.layout).toBe('grid')
  })

  test('setActiveTab persists the active tab id and accepts null', () => {
    const ws = repo.create('/a')
    expect(repo.setActiveTab(ws.id, 't1').activeTabId).toBe('t1')
    expect(repo.setActiveTab(ws.id, null).activeTabId).toBeNull()
  })

  test('rename throws for a missing workspace', () => {
    expect(() => repo.rename('missing', 'x')).toThrow(/not found/i)
  })
})
