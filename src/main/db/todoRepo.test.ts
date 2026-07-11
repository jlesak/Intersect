import { beforeEach, describe, expect, test } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { createTodoRepo, type TodoRepo } from './todoRepo'
import { makeTestDb, makeTestDeps } from './testkit'

describe('todoRepo', () => {
  let db: DatabaseSync
  let repo: TodoRepo

  beforeEach(() => {
    db = makeTestDb()
    repo = createTodoRepo(db, makeTestDeps())
  })

  test('create stores an open task with a deterministic id and returns the canonical row', () => {
    const task = repo.create('Ask Marek about the review', '2026-07-10')
    expect(task).toEqual({
      id: 'id-1',
      text: 'Ask Marek about the review',
      description: '',
      dueDay: '2026-07-10',
      priority: 4,
      sortOrder: 0,
      doneAt: null
    })
  })

  test('create trims the text and a task without a due day round-trips as null', () => {
    const task = repo.create('  check the deploy logs  ', null)
    expect(task.text).toBe('check the deploy logs')
    expect(task.dueDay).toBeNull()
  })

  test('create accepts an explicit priority', () => {
    const task = repo.create('urgent', null, 1)
    expect(task.priority).toBe(1)
  })

  test('create rejects empty and whitespace-only text with a message-only error', () => {
    expect(() => repo.create('', null)).toThrow(/must not be empty/i)
    expect(() => repo.create('   ', null)).toThrow(/must not be empty/i)
  })

  test('create rejects a malformed due day', () => {
    expect(() => repo.create('task', '10.07.2026')).toThrow(/invalid due day/i)
    expect(() => repo.create('task', '2026-7-1')).toThrow(/invalid due day/i)
  })

  test('create rejects an out-of-range priority', () => {
    // @ts-expect-error - deliberately out of range to exercise runtime validation
    expect(() => repo.create('task', null, 0)).toThrow(/invalid priority/i)
    // @ts-expect-error - deliberately out of range to exercise runtime validation
    expect(() => repo.create('task', null, 5)).toThrow(/invalid priority/i)
  })

  test('each new task is appended to the end of the open list', () => {
    repo.create('first', null)
    repo.create('second', null)
    repo.create('third', null)
    expect(repo.listOpen().map((t) => t.text)).toEqual(['first', 'second', 'third'])
    expect(repo.listOpen().map((t) => t.sortOrder)).toEqual([0, 1, 2])
  })

  test('a new task lands after the open maximum, ignoring done tasks', () => {
    const a = repo.create('a', null)
    repo.create('b', null)
    repo.setDone(a.id, true)
    const c = repo.create('c', null)
    // Only 'b' (sort_order 1) is open, so 'c' takes 2 - done rows do not cap the order.
    expect(c.sortOrder).toBe(2)
    expect(repo.listOpen().map((t) => t.text)).toEqual(['b', 'c'])
  })

  describe('listOpen ordering', () => {
    test('orders by priority first, most urgent (P1) before least (P4)', () => {
      repo.create('low', null, 4)
      repo.create('urgent', null, 1)
      repo.create('medium', null, 3)
      repo.create('high', null, 2)
      expect(repo.listOpen().map((t) => t.text)).toEqual(['urgent', 'high', 'medium', 'low'])
    })

    test('within a priority, orders by due date, earliest first', () => {
      repo.create('later', '2026-07-20', 2)
      repo.create('sooner', '2026-07-10', 2)
      repo.create('soonest', '2026-07-01', 2)
      expect(repo.listOpen().map((t) => t.text)).toEqual(['soonest', 'sooner', 'later'])
    })

    test('within a priority, a task with no due day sorts after every dated task', () => {
      repo.create('no due day', null, 2)
      repo.create('has due day', '2026-12-31', 2)
      expect(repo.listOpen().map((t) => t.text)).toEqual(['has due day', 'no due day'])
    })

    test('falls back to creation order when priority and due day both tie', () => {
      repo.create('first', '2026-07-10', 3)
      repo.create('second', '2026-07-10', 3)
      expect(repo.listOpen().map((t) => t.text)).toEqual(['first', 'second'])
    })
  })

  describe('update', () => {
    test('edits any subset of fields, leaving the rest untouched', () => {
      const task = repo.create('a', '2026-07-10', 3)
      const updated = repo.update(task.id, { text: 'b' })
      expect(updated.text).toBe('b')
      expect(updated.dueDay).toBe('2026-07-10')
      expect(updated.priority).toBe(3)
    })

    test('updates description, due day, and priority', () => {
      const task = repo.create('a', null)
      const updated = repo.update(task.id, {
        description: 'more detail',
        dueDay: '2026-08-01',
        priority: 1
      })
      expect(updated.description).toBe('more detail')
      expect(updated.dueDay).toBe('2026-08-01')
      expect(updated.priority).toBe(1)
    })

    test('clears a due day by passing null explicitly', () => {
      const task = repo.create('a', '2026-07-10')
      const updated = repo.update(task.id, { dueDay: null })
      expect(updated.dueDay).toBeNull()
    })

    test('trims updated text and rejects empty text', () => {
      const task = repo.create('a', null)
      expect(repo.update(task.id, { text: '  b  ' }).text).toBe('b')
      expect(() => repo.update(task.id, { text: '   ' })).toThrow(/must not be empty/i)
    })

    test('rejects a malformed due day and an out-of-range priority', () => {
      const task = repo.create('a', null)
      expect(() => repo.update(task.id, { dueDay: 'not-a-day' })).toThrow(/invalid due day/i)
      // @ts-expect-error - deliberately out of range to exercise runtime validation
      expect(() => repo.update(task.id, { priority: 0 })).toThrow(/invalid priority/i)
    })

    test('an empty patch is a no-op that still returns the canonical task', () => {
      const task = repo.create('a', null)
      expect(repo.update(task.id, {})).toEqual(task)
    })

    test('update of a missing task throws a message-only error', () => {
      expect(() => repo.update('nope', { text: 'x' })).toThrow(/not found/i)
    })
  })

  test('setDone(true) stamps the completion time and moves the task out of the open list', () => {
    const a = repo.create('a', null)
    repo.create('b', null)
    const done = repo.setDone(a.id, true)
    expect(done.doneAt).not.toBeNull()
    expect(repo.listOpen().map((t) => t.text)).toEqual(['b'])
    expect(repo.listDone().map((t) => t.text)).toEqual(['a'])
  })

  test('listDone orders by completion time, most recent first', () => {
    const a = repo.create('a', null)
    const b = repo.create('b', null)
    const c = repo.create('c', null)
    repo.setDone(b.id, true)
    repo.setDone(a.id, true)
    repo.setDone(c.id, true)
    expect(repo.listDone().map((t) => t.text)).toEqual(['c', 'a', 'b'])
  })

  test('setDone(false) clears the stamp and appends the task to the end of the open list', () => {
    const a = repo.create('a', null)
    repo.create('b', null)
    repo.create('c', null)
    repo.setDone(a.id, true)
    const reopened = repo.setDone(a.id, false)
    expect(reopened.doneAt).toBeNull()
    expect(repo.listOpen().map((t) => t.text)).toEqual(['b', 'c', 'a'])
    expect(repo.listDone()).toEqual([])
  })

  test('setDone of a missing task throws a message-only error', () => {
    expect(() => repo.setDone('nope', true)).toThrow(/not found/i)
  })

  test('remove hard-deletes from either list', () => {
    const a = repo.create('a', null)
    const b = repo.create('b', null)
    repo.setDone(b.id, true)
    repo.remove(a.id)
    repo.remove(b.id)
    expect(repo.listOpen()).toEqual([])
    expect(repo.listDone()).toEqual([])
  })
})
