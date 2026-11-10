import { beforeEach, describe, expect, test } from 'vitest'
import { createTodoRepo, type TodoRepo } from './todoRepo'
import { makeTestDb } from './testkit'
import type { DatabaseSync } from 'node:sqlite'

let db: DatabaseSync
let repo: TodoRepo
let id = 0
let now = Date.parse('2026-11-10T12:00:00Z')
beforeEach(() => {
  db = makeTestDb()
  id = 0
  now = Date.parse('2026-11-10T12:00:00Z')
  repo = createTodoRepo(db, { newId: () => `id-${++id}`, now: () => now })
})

describe('TODO planning persistence', () => {
  test('projects, tags, scope order and invalid saved references survive reads', () => {
    const p = repo.createProject('Build')
    const tag = repo.createTag('Small')
    const first = repo.create({ text: 'first', projectId: p.id, tagIds: [tag.id],
      priority: 1, size: 'S' })
    const second = repo.create({ text: 'second', projectId: p.id })
    expect(repo.reorder([second.id, first.id], p.id).map((task) => task.id))
      .toEqual([second.id, first.id])
    const filter = repo.createFilter('Urgent', { version: 1, projects: [p.id], tags: [tag.id] })
    expect(repo.query(filter.query, '2026-11-10')).toMatchObject({ status: 'valid',
      tasks: [{ id: first.id }] })
    repo.removeTag(tag.id)
    expect(repo.listFilters()[0].validity).toBe('missingReferences')
    expect(repo.query(filter.query, '2026-11-10')).toEqual({ status: 'invalid',
      missingReferences: ['tag'] })
    repo.removeProject(p.id)
    expect(repo.getById(first.id)?.projectId).toBeNull()
  })
  test('multiple reusable tags, size and time round-trip; deleting a tag only removes its link', () => {
    const firstTag = repo.createTag('Quick')
    const secondTag = repo.createTag('Home')
    const first = repo.create({ text: 'first', dueDay: '2026-11-10', dueTime: '09:30',
      size: 'XS', priority: 2, tagIds: [firstTag.id, secondTag.id] })
    const second = repo.create({ text: 'second', tagIds: [firstTag.id] })
    expect(repo.getById(first.id)).toMatchObject({ dueTime: '09:30', size: 'XS',
      priority: 2, tagIds: [firstTag.id, secondTag.id] })
    expect(repo.getById(second.id)?.tagIds).toEqual([firstTag.id])
    repo.updateTag(firstTag.id, 'Fast')
    expect(repo.listTags()).toContainEqual({ id: firstTag.id, name: 'Fast' })
    repo.removeTag(firstTag.id)
    expect(repo.getById(first.id)?.tagIds).toEqual([secondTag.id])
    expect(repo.getById(second.id)?.tagIds).toEqual([])
    expect(() => repo.create({ text: 'bad', size: 'Huge' as 'XL' })).toThrow('Invalid size')
    expect(() => repo.create({ text: 'bad', dueTime: '25:00' })).toThrow('Invalid due time')
  })
  test('a repeated completion advances once and persists one occurrence', () => {
    const task = repo.create({ text: 'repeat', dueDay: '2026-11-10', recurrence: {
      mode: 'fixed', unit: 'day', interval: 1, anchorDay: '2026-11-10' } })
    expect(repo.complete(task.id, task.revision!).status).toBe('completed')
    expect(repo.complete(task.id, task.revision!).status).toBe('stale')
    expect(repo.getById(task.id)?.dueDay).toBe('2026-11-11')
    expect(repo.history(task.id)).toHaveLength(1)
    const reopened = createTodoRepo(db, { newId: () => 'unused', now: () => now })
    expect(reopened.history(task.id)).toHaveLength(1)
    reopened.remove(task.id)
    expect((db.prepare('SELECT count(*) AS n FROM todo_completion').get() as { n: number }).n)
      .toBe(0)
  })
  test('stale schedule and failed history insert cannot advance', () => {
    const task = repo.create({ text: 'repeat', dueDay: '2026-11-10', recurrence: {
      mode: 'fixed', unit: 'day', interval: 1, anchorDay: '2026-11-10' } })
    expect(repo.update(task.id, { text: 'repeat renamed', dueDay: '2026-11-10' }).revision)
      .toBe(task.revision)
    repo.update(task.id, { dueDay: '2026-11-12' })
    expect(repo.complete(task.id, task.revision!).status).toBe('stale')
    db.exec(`CREATE TRIGGER fail_history BEFORE INSERT ON todo_completion BEGIN
      SELECT RAISE(ABORT, 'history failed'); END`)
    const current = repo.getById(task.id)!
    expect(() => repo.complete(task.id, current.revision!)).toThrow('history failed')
    expect(repo.getById(task.id)).toEqual(current)
  })
})
