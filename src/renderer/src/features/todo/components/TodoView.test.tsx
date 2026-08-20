import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { TodoTask } from '@common/domain'

vi.mock('../ipc')
vi.mock('@renderer/features/workItems', () => ({ launchFromTodoTask: vi.fn() }))
import { launchFromTodoTask } from '@renderer/features/workItems'
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

/** What a TODO row offers once it is hovered or focused, and what the keyboard can reach. */
describe('TodoView row actions', () => {
  const launch = vi.mocked(launchFromTodoTask)

  beforeEach(() => {
    vi.useFakeTimers()
    launch.mockReset()
    const done = [task('z', { doneAt: 1000 })]
    mocked.list.mockResolvedValue({ open: OPEN, done })
    useTodoStore.setState({
      status: 'ready',
      error: null,
      open: OPEN,
      done,
      showDone: true,
      pendingFocusId: null
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    useTodoStore.setState({ status: 'idle', open: [], done: [], showDone: false })
  })

  const mount = async (): Promise<void> => {
    await act(async () => {
      render(<TodoView />)
    })
  }

  test('an open task offers the session launch, and pressing it launches that task', async () => {
    await mount()

    fireEvent.click(within(rowOf('Task b') as HTMLElement).getByRole('button', { name: 'Start session' }))

    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch.mock.calls[0][0].id).toBe('b')
  })

  test('a done task offers no session launch, because there is no work left to start', async () => {
    await mount()

    expect(within(rowOf('Task z') as HTMLElement).queryByRole('button', { name: 'Start session' })).toBeNull()
  })

  test('pressing the launch stays inside the bar, so the row is neither selected nor edited', async () => {
    await mount()

    fireEvent.click(within(rowOf('Task b') as HTMLElement).getByRole('button', { name: 'Start session' }))

    expect(document.querySelectorAll('.ix-todo-item--selected')).toHaveLength(0)
    expect(document.querySelectorAll('.ix-todo-item--editing')).toHaveLength(0)
  })

  test('Enter on a focused row opens its inline editor, as double-clicking it does', async () => {
    await mount()

    fireEvent.keyDown(rowOf('Task b') as HTMLElement, { key: 'Enter' })

    expect(document.querySelectorAll('.ix-todo-item--editing')).toHaveLength(1)
    expect(screen.getByDisplayValue('Task b')).toBeTruthy()
  })

  test('Cmd+Enter does nothing, because a task has no home outside this list', async () => {
    await mount()

    fireEvent.keyDown(rowOf('Task b') as HTMLElement, { key: 'Enter', metaKey: true })

    expect(document.querySelectorAll('.ix-todo-item--editing')).toHaveLength(0)
    expect(launch).not.toHaveBeenCalled()
  })

  test('every open row is a tab stop, so the launch is reachable without a mouse', async () => {
    await mount()

    expect((rowOf('Task b') as HTMLElement).tabIndex).toBe(0)
  })
})

/**
 * Which gesture does what to a row. A click is an incidental gesture and only points at a task;
 * editing waits for one the user has to mean.
 */
describe('TodoView row activation', () => {
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

  const mount = async (): Promise<void> => {
    await act(async () => {
      render(<TodoView />)
    })
  }

  test('a plain click selects the row and leaves the editor closed', async () => {
    await mount()

    fireEvent.click(rowOf('Task b') as HTMLElement)

    expect(rowOf('Task b')?.className).toContain('ix-todo-item--selected')
    expect(document.querySelectorAll('.ix-todo-item--editing')).toHaveLength(0)
  })

  test('a click also moves keyboard focus to the row, so Enter picks up from there', async () => {
    await mount()

    fireEvent.click(rowOf('Task b') as HTMLElement)

    expect(document.activeElement).toBe(rowOf('Task b'))
  })

  test('a double-click opens the inline editor', async () => {
    await mount()

    fireEvent.dblClick(rowOf('Task b') as HTMLElement)

    expect(document.querySelectorAll('.ix-todo-item--editing')).toHaveLength(1)
    expect(screen.getByDisplayValue('Task b')).toBeTruthy()
  })

  test('selecting a second row deselects the first', async () => {
    await mount()

    fireEvent.click(rowOf('Task a') as HTMLElement)
    fireEvent.click(rowOf('Task c') as HTMLElement)

    expect(document.querySelectorAll('.ix-todo-item--selected')).toHaveLength(1)
    expect(rowOf('Task c')?.className).toContain('ix-todo-item--selected')
  })

  test('the pencil still opens the editor', async () => {
    await mount()

    fireEvent.click(within(rowOf('Task b') as HTMLElement).getByTitle('Edit'))

    expect(document.querySelectorAll('.ix-todo-item--editing')).toHaveLength(1)
    expect(screen.getByDisplayValue('Task b')).toBeTruthy()
  })

  test('opening the editor drops the selection, so a row is never both at once', async () => {
    await mount()

    const row = rowOf('Task b') as HTMLElement
    fireEvent.click(row)
    fireEvent.dblClick(row)

    expect(document.querySelectorAll('.ix-todo-item--selected')).toHaveLength(0)
    expect(document.querySelectorAll('.ix-todo-item--editing')).toHaveLength(1)
  })

  test('the drag grip points at nothing: it neither selects the row nor edits it', async () => {
    await mount()

    fireEvent.click(within(rowOf('Task b') as HTMLElement).getByRole('button', { name: /Move Task b/ }))

    expect(document.querySelectorAll('.ix-todo-item--selected')).toHaveLength(0)
    expect(document.querySelectorAll('.ix-todo-item--editing')).toHaveLength(0)
  })
})
