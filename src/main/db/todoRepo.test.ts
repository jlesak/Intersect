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
      dueDay: '2026-07-10',
      sortOrder: 0,
      doneAt: null
    })
  })

  test('create trims the text and a task without a due day round-trips as null', () => {
    const task = repo.create('  check the deploy logs  ', null)
    expect(task.text).toBe('check the deploy logs')
    expect(task.dueDay).toBeNull()
  })

  test('create rejects empty and whitespace-only text with a message-only error', () => {
    expect(() => repo.create('', null)).toThrow(/must not be empty/i)
    expect(() => repo.create('   ', null)).toThrow(/must not be empty/i)
  })

  test('create rejects a malformed due day', () => {
    expect(() => repo.create('task', '10.07.2026')).toThrow(/invalid due day/i)
    expect(() => repo.create('task', '2026-7-1')).toThrow(/invalid due day/i)
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

  test('reorder rewrites sortOrder to match the given order and persists it', () => {
    const a = repo.create('a', null)
    const b = repo.create('b', null)
    const c = repo.create('c', null)
    const reordered = repo.reorder([c.id, a.id, b.id])
    expect(reordered.map((t) => t.id)).toEqual([c.id, a.id, b.id])
    expect(reordered.map((t) => t.sortOrder)).toEqual([0, 1, 2])
    expect(repo.listOpen().map((t) => t.id)).toEqual([c.id, a.id, b.id])
  })

  test('reorder never touches done tasks', () => {
    const a = repo.create('a', null)
    const b = repo.create('b', null)
    repo.setDone(b.id, true)
    const doneOrder = repo.listDone()[0].sortOrder
    repo.reorder([b.id, a.id])
    expect(repo.listDone()[0].sortOrder).toBe(doneOrder)
    expect(repo.listOpen().map((t) => t.id)).toEqual([a.id])
  })
})
