import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { TodoTask } from '@common/domain'

vi.mock('../ipc')
import * as api from '../ipc'
import { useTodoStore } from '../store'
import { TodoView } from './TodoView'

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

const OPEN = [task('a'), task('b'), task('c')]

/** The row of a task, identified by its text - the list exposes no per-row id in the markup. */
const rowOf = (text: string): Element | undefined =>
  [...document.querySelectorAll('.ix-todo-item')].find(
    (row) => row.querySelector('.ix-todo-item__text')?.textContent === text
  )

/**
 * The TODO list mounted client-side: it subscribes to the store, so only a real root can expose a
 * re-render loop or a focus request that never lands.
 */
describe('TodoView', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocked.list.mockResolvedValue({ open: OPEN, done: [] })
    useTodoStore.setState({
      status: 'ready',
      error: null,
      open: OPEN,
      done: [],
      showDone: false,
      pendingFocusId: null
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    useTodoStore.setState({ status: 'idle', open: [], done: [], pendingFocusId: null })
  })

  test('mounts and settles without a render loop', async () => {
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        render(<TodoView />)
      })
      expect(logged).toEqual([])
      expect(document.querySelectorAll('.ix-todo-item')).toHaveLength(3)
    } finally {
      consoleError.mockRestore()
    }
  })

  test('a task the user was sent to is marked, and the request is spent', async () => {
    await act(async () => {
      render(<TodoView />)
    })
    await act(async () => {
      useTodoStore.getState().focusTask('b')
    })

    expect(rowOf('Task b')?.className).toContain('ix-todo-item--focused')
    expect(document.querySelectorAll('.ix-todo-item--focused')).toHaveLength(1)
    // Honoured, so returning to this section later cannot replay it.
    expect(useTodoStore.getState().pendingFocusId).toBeNull()
  })

  test('the mark expires instead of turning into a permanent selection', async () => {
    await act(async () => {
      render(<TodoView />)
    })
    await act(async () => {
      useTodoStore.getState().focusTask('b')
    })
    await act(async () => {
      vi.advanceTimersByTime(3_000)
    })

    expect(document.querySelectorAll('.ix-todo-item--focused')).toHaveLength(0)
  })

  test('a request for a task that is no longer open marks nothing and still clears', async () => {
    await act(async () => {
      render(<TodoView />)
    })
    await act(async () => {
      useTodoStore.getState().focusTask('gone')
    })

    expect(document.querySelectorAll('.ix-todo-item--focused')).toHaveLength(0)
    expect(useTodoStore.getState().pendingFocusId).toBeNull()
  })
})
