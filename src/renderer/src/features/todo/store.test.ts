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
    await useTodoStore.getState().add('Task n', '2026-07-10')
    expect(mocked.add).toHaveBeenCalledWith('Task n', '2026-07-10')
    expect(useTodoStore.getState().open.map((t) => t.id)).toEqual(['n'])
  })

  test('update edits then reloads', async () => {
    const updated = task('a', { text: 'edited', description: 'detail' })
    mocked.update.mockResolvedValue(updated)
    mocked.list.mockResolvedValue({ open: [updated], done: [] })
    await useTodoStore.getState().update('a', { text: 'edited', description: 'detail' })
    expect(mocked.update).toHaveBeenCalledWith('a', { text: 'edited', description: 'detail' })
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

describe('reorder', () => {
  test('applies sortOrder optimistically before IPC resolves, then accepts canonical state', async () => {
    useTodoStore.setState({
      status: 'ready',
      open: [task('a', { sortOrder: 0 }), task('b', { sortOrder: 1 }), task('c', { sortOrder: 2 })]
    })
    let resolve!: (tasks: TodoTask[]) => void
    mocked.reorder.mockReturnValue(new Promise((done) => (resolve = done)))

    const pending = useTodoStore.getState().reorder(['c', 'a', 'b'])
    expect(useTodoStore.getState().open.map((item) => [item.id, item.sortOrder])).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2]
    ])
    const canonical = [
      task('c', { sortOrder: 0 }),
      task('a', { sortOrder: 1 }),
      task('b', { sortOrder: 2 })
    ]
    resolve(canonical)
    await pending

    expect(mocked.reorder).toHaveBeenCalledWith(['c', 'a', 'b'])
    expect(useTodoStore.getState().open).toEqual(canonical)
    expect(mocked.list).not.toHaveBeenCalled()
  })

  test('rejects an incomplete local order without losing tasks or calling IPC', async () => {
    const original = [task('a'), task('b')]
    useTodoStore.setState({ status: 'ready', open: original })

    await useTodoStore.getState().reorder(['b'])

    expect(useTodoStore.getState().open).toEqual(original)
    expect(mocked.reorder).not.toHaveBeenCalled()
  })

  test('an older IPC response cannot overwrite a newer optimistic reorder', async () => {
    useTodoStore.setState({ status: 'ready', open: [task('a'), task('b'), task('c')] })
    let resolveFirst!: (tasks: TodoTask[]) => void
    let resolveSecond!: (tasks: TodoTask[]) => void
    mocked.reorder
      .mockReturnValueOnce(new Promise((done) => (resolveFirst = done)))
      .mockReturnValueOnce(new Promise((done) => (resolveSecond = done)))

    const first = useTodoStore.getState().reorder(['b', 'a', 'c'])
    const second = useTodoStore.getState().reorder(['c', 'b', 'a'])
    resolveSecond([task('c'), task('b'), task('a')])
    await second
    resolveFirst([task('b'), task('a'), task('c')])
    await first

    expect(useTodoStore.getState().open.map((item) => item.id)).toEqual(['c', 'b', 'a'])
  })

  test('a failed reorder resyncs from main', async () => {
    useTodoStore.setState({ status: 'ready', open: [task('a'), task('b')] })
    mocked.reorder.mockRejectedValue(new Error('nope'))
    mocked.list.mockResolvedValue({ open: [task('a'), task('b')], done: [] })

    await useTodoStore.getState().reorder(['b', 'a'])

    expect(useTodoStore.getState().open.map((item) => item.id)).toEqual(['a', 'b'])
  })
})
