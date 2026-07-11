import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { TodoTask } from '@common/domain'

vi.mock('./ipc')
vi.mock('@renderer/shared/ui/toast')
import * as api from './ipc'
import { useTodoStore } from './store'

const mocked = vi.mocked(api)

const task = (id: string, over: Partial<TodoTask> = {}): TodoTask => ({
  id,
  text: `Task ${id}`,
  description: '',
  dueDay: null,
  priority: 4,
  sortOrder: 0,
  doneAt: null,
  ...over
})

const reset = (): void => {
  useTodoStore.setState(
    { status: 'idle', error: null, open: [], done: [], showDone: false },
    false
  )
}

beforeEach(() => {
  reset()
  vi.clearAllMocks()
})

describe('load', () => {
  test('fetches both lists and is ready', async () => {
    mocked.list.mockResolvedValue({ open: [task('a')], done: [task('z', { doneAt: 5 })] })
    await useTodoStore.getState().load()
    const s = useTodoStore.getState()
    expect(s.status).toBe('ready')
    expect(s.open.map((t) => t.id)).toEqual(['a'])
    expect(s.done.map((t) => t.id)).toEqual(['z'])
  })

  test('sets error status when the IPC call fails', async () => {
    mocked.list.mockRejectedValue(new Error('db gone'))
    await useTodoStore.getState().load()
    expect(useTodoStore.getState().status).toBe('error')
    expect(useTodoStore.getState().error).toMatch(/db gone/)
  })

  test('a later load recovers from a previous error', async () => {
    mocked.list.mockRejectedValueOnce(new Error('db gone'))
    await useTodoStore.getState().load()
    mocked.list.mockResolvedValue({ open: [task('a')], done: [] })
    await useTodoStore.getState().load()
    expect(useTodoStore.getState().status).toBe('ready')
    expect(useTodoStore.getState().error).toBeNull()
  })
})

describe('showDone', () => {
  test('starts hidden and toggles', () => {
    expect(useTodoStore.getState().showDone).toBe(false)
    useTodoStore.getState().toggleShowDone()
    expect(useTodoStore.getState().showDone).toBe(true)
    useTodoStore.getState().toggleShowDone()
    expect(useTodoStore.getState().showDone).toBe(false)
  })
})

describe('mutations reload both lists', () => {
  test('add creates then reloads', async () => {
    const created = task('n')
    mocked.add.mockResolvedValue(created)
    mocked.list.mockResolvedValue({ open: [created], done: [] })
    await useTodoStore.getState().add('Task n', '2026-07-10', 2)
    expect(mocked.add).toHaveBeenCalledWith('Task n', '2026-07-10', 2)
    expect(useTodoStore.getState().open.map((t) => t.id)).toEqual(['n'])
  })

  test('update edits then reloads', async () => {
    const updated = task('a', { text: 'edited', priority: 1 })
    mocked.update.mockResolvedValue(updated)
    mocked.list.mockResolvedValue({ open: [updated], done: [] })
    await useTodoStore.getState().update('a', { text: 'edited', priority: 1 })
    expect(mocked.update).toHaveBeenCalledWith('a', { text: 'edited', priority: 1 })
    expect(useTodoStore.getState().open).toEqual([updated])
  })

  test('toggleDone(true) moves the task into done', async () => {
    useTodoStore.setState({ status: 'ready', open: [task('a')] })
    mocked.setDone.mockResolvedValue(task('a', { doneAt: 5 }))
    mocked.list.mockResolvedValue({ open: [], done: [task('a', { doneAt: 5 })] })
    await useTodoStore.getState().toggleDone('a', true)
    expect(mocked.setDone).toHaveBeenCalledWith('a', true)
    expect(useTodoStore.getState().open).toEqual([])
    expect(useTodoStore.getState().done.map((t) => t.id)).toEqual(['a'])
  })

  test('toggleDone(false) returns the task to the open list', async () => {
    useTodoStore.setState({ status: 'ready', done: [task('a', { doneAt: 5 })] })
    mocked.setDone.mockResolvedValue(task('a'))
    mocked.list.mockResolvedValue({ open: [task('a')], done: [] })
    await useTodoStore.getState().toggleDone('a', false)
    expect(mocked.setDone).toHaveBeenCalledWith('a', false)
    expect(useTodoStore.getState().open.map((t) => t.id)).toEqual(['a'])
    expect(useTodoStore.getState().done).toEqual([])
  })

  test('remove deletes then reloads', async () => {
    useTodoStore.setState({ status: 'ready', open: [task('a')] })
    mocked.remove.mockResolvedValue(undefined)
    mocked.list.mockResolvedValue({ open: [], done: [] })
    await useTodoStore.getState().remove('a')
    expect(mocked.remove).toHaveBeenCalledWith('a')
    expect(useTodoStore.getState().open).toEqual([])
  })

  test('a failed mutation still reloads so the section resyncs', async () => {
    mocked.add.mockRejectedValue(new Error('nope'))
    mocked.list.mockResolvedValue({ open: [task('kept')], done: [] })
    await useTodoStore.getState().add('x', null)
    expect(useTodoStore.getState().open.map((t) => t.id)).toEqual(['kept'])
    expect(useTodoStore.getState().status).toBe('ready')
  })
})
