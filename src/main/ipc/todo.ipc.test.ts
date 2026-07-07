import { beforeEach, describe, expect, test } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { TodoTask } from '@common/domain'
import { Channel, type IpcApi } from '@common/ipc'
import { createTodoRepo, type TodoRepo } from '../db/todoRepo'
import { makeTestDb, makeTestDeps } from '../db/testkit'
import { createTodoHandlers, registerTodoHandlers } from './todo.ipc'

describe('todo handlers', () => {
  let db: DatabaseSync
  let todos: TodoRepo
  let h: IpcApi['todo']

  beforeEach(() => {
    db = makeTestDb()
    todos = createTodoRepo(db, makeTestDeps())
    h = createTodoHandlers({ db, todos })
  })

  test('add creates an open task and list returns both lists', async () => {
    const task = await h.add('Ask Marek about the review', '2026-07-10')
    expect(task.text).toBe('Ask Marek about the review')
    expect(await h.list()).toEqual({ open: [task], done: [] })
  })

  test('setDone moves a task between the lists in both directions', async () => {
    const a = await h.add('a', null)
    await h.add('b', null)

    const done = await h.setDone(a.id, true)
    expect(done.doneAt).not.toBeNull()
    let lists = await h.list()
    expect(lists.open.map((t) => t.text)).toEqual(['b'])
    expect(lists.done.map((t) => t.text)).toEqual(['a'])

    await h.setDone(a.id, false)
    lists = await h.list()
    expect(lists.open.map((t) => t.text)).toEqual(['b', 'a'])
    expect(lists.done).toEqual([])
  })

  test('remove deletes the task', async () => {
    const a = await h.add('a', null)
    await h.remove(a.id)
    expect((await h.list()).open).toEqual([])
  })

  test('reorder persists the new open order atomically', async () => {
    const a = await h.add('a', null)
    const b = await h.add('b', null)
    const c = await h.add('c', null)
    const reordered = await h.reorder([c.id, a.id, b.id])
    expect(reordered.map((t) => t.id)).toEqual([c.id, a.id, b.id])
    expect((await h.list()).open.map((t) => t.id)).toEqual([c.id, a.id, b.id])
    // The handler owns the transaction; nothing must be left open afterwards.
    expect(db.isTransaction).toBe(false)
  })

  test('a repo validation error crosses as a message-only Error', async () => {
    await expect(h.add('   ', null)).rejects.toThrow(/must not be empty/i)
    await expect(h.add('task', 'not-a-day')).rejects.toThrow(/invalid due day/i)
    await expect(h.setDone('nope', true)).rejects.toThrow(/not found/i)
  })

  test('wraps a non-Error throw into an Error with a message', async () => {
    const throwing = createTodoHandlers({
      db,
      todos: {
        ...todos,
        listOpen: () => {
          throw 'boom'
        }
      }
    })
    await expect(throwing.list()).rejects.toThrow(/boom/)
  })
})

describe('registerTodoHandlers', () => {
  test('binds the five request/response channels to the handlers', async () => {
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
        registered.set(channel, listener)
      }
    }
    const db = makeTestDb()
    const h = createTodoHandlers({ db, todos: createTodoRepo(db, makeTestDeps()) })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTodoHandlers(ipcMain as any, h)

    expect([...registered.keys()].sort()).toEqual(
      [Channel.todoList, Channel.todoAdd, Channel.todoSetDone, Channel.todoRemove, Channel.todoReorder].sort()
    )

    const added = (await registered.get(Channel.todoAdd)!({}, 'buy a monitor', null)) as TodoTask
    expect(added.text).toBe('buy a monitor')
    const lists = (await registered.get(Channel.todoList)!({})) as { open: TodoTask[] }
    expect(lists.open.map((t) => t.text)).toEqual(['buy a monitor'])
  })
})
