import { beforeEach, describe, expect, test } from 'vitest'
import { createTodoRepo, type TodoRepo } from './todoRepo'
import { makeTestDb } from './testkit'
import type { DatabaseSync } from 'node:sqlite'
import type { TodoRecurrence, TodoTask } from '@common/domain'

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
  describe('editing the repeat rule of a recurring task', () => {
    const at = (day: string): void => {
      const [year, month, date] = day.split('-').map(Number)
      now = new Date(year, month - 1, date, 12).getTime()
    }
    /** Creates a task on `created`, then completes it on `completed`, as a user would. */
    const repeating = (rule: Omit<TodoRecurrence, 'anchorDay'>, created: string,
      completed: string): TodoTask => {
      at(created)
      const task = repo.create({ text: 'repeat', dueDay: created,
        recurrence: { ...rule, anchorDay: created } })
      at(completed)
      return repo.complete(task.id, task.revision!).task
    }
    /**
     * Saves the task as the task editor does: the whole rule, with the due day in the date field
     * as its anchor. The editor never sends the stored anchor; the core decides it.
     */
    const editRule = (task: TodoTask, change: Partial<Omit<TodoRecurrence, 'anchorDay'>>,
      dueDay = task.dueDay!): TodoTask =>
      repo.update(task.id, { text: task.text, dueDay,
        recurrence: { mode: task.recurrence!.mode, unit: task.recurrence!.unit,
          interval: task.recurrence!.interval, ...change, anchorDay: dueDay } })
    const completeOn = (task: TodoTask, day: string): string | null => {
      at(day)
      return repo.complete(task.id, task.revision!).task.dueDay
    }

    test('a new interval counts from the due day the task showed', () => {
      const task = repeating({ mode: 'fixed', unit: 'day', interval: 1 }, '2026-11-01', '2026-11-11')
      expect(task.dueDay).toBe('2026-11-12')
      expect(completeOn(editRule(task, { interval: 3 }), '2026-11-12')).toBe('2026-11-15')
    })

    test('a change to weekly keeps the weekday the task showed', () => {
      const task = repeating({ mode: 'fixed', unit: 'day', interval: 1 }, '2026-11-01', '2026-11-11')
      expect(completeOn(editRule(task, { unit: 'week' }), '2026-11-12')).toBe('2026-11-19')
    })

    test('switching after-completion to fixed starts the rhythm at the due day', () => {
      const task = repeating({ mode: 'after_completion', unit: 'day', interval: 2 },
        '2026-11-01', '2026-11-10')
      expect(task.dueDay).toBe('2026-11-12')
      expect(completeOn(editRule(task, { mode: 'fixed' }), '2026-11-12')).toBe('2026-11-14')
    })

    test('a new monthly interval keeps returning to the 31st', () => {
      const task = repeating({ mode: 'fixed', unit: 'month', interval: 1 }, '2026-01-31', '2026-01-31')
      expect(task.dueDay).toBe('2026-02-28')
      const edited = editRule(task, { interval: 2 })
      expect(completeOn(edited, '2026-02-28')).toBe('2026-04-30')
      expect(completeOn(repo.getById(task.id)!, '2026-04-30')).toBe('2026-06-30')
      expect(completeOn(repo.getById(task.id)!, '2026-06-30')).toBe('2026-08-31')
    })

    test('a rename ignores the shown due day the editor sends as anchor', () => {
      const task = repeating({ mode: 'fixed', unit: 'month', interval: 1 }, '2026-01-31', '2026-01-31')
      expect(task.dueDay).toBe('2026-02-28')
      const renamed = repo.update(task.id, { text: 'renamed', dueDay: '2026-02-28',
        recurrence: { mode: 'fixed', unit: 'month', interval: 1, anchorDay: '2026-02-28' } })
      expect(renamed.revision).toBe(task.revision)
      expect(completeOn(renamed, '2026-02-28')).toBe('2026-03-31')
    })

    test('an edit that leaves the rule and the date alone keeps the rhythm and revision', () => {
      const task = repeating({ mode: 'fixed', unit: 'month', interval: 1 }, '2026-01-31', '2026-01-31')
      const edited = editRule(task, {})
      expect(edited.revision).toBe(task.revision)
      expect(completeOn(edited, '2026-02-28')).toBe('2026-03-31')
    })

    test('moving only the due day restarts the rhythm there', () => {
      const task = repeating({ mode: 'fixed', unit: 'day', interval: 3 }, '2026-11-01', '2026-11-02')
      expect(task.dueDay).toBe('2026-11-04')
      expect(completeOn(editRule(task, {}, '2026-11-05'), '2026-11-05')).toBe('2026-11-08')
    })
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
