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

  test('a double-press on one of the row’s own controls stays with that control', async () => {
    await mount()

    const row = rowOf('Task b') as HTMLElement
    const editorsAfterDoublePress = (control: Element): number => {
      fireEvent.dblClick(control)
      return document.querySelectorAll('.ix-todo-item--editing').length
    }

    expect({
      grip: editorsAfterDoublePress(within(row).getByRole('button', { name: /Move Task b/ })),
      check: editorsAfterDoublePress(within(row).getByTitle('Mark as done')),
      launch: editorsAfterDoublePress(within(row).getByRole('button', { name: 'Start session' })),
      overflow: editorsAfterDoublePress(within(row).getByRole('button', { name: 'More actions' })),
      trash: editorsAfterDoublePress(within(row).getByTitle('Delete'))
    }).toEqual({ grip: 0, check: 0, launch: 0, overflow: 0, trash: 0 })
  })

  test('a double-click on the row’s own text still opens the editor', async () => {
    await mount()

    fireEvent.dblClick(
      (rowOf('Task b') as HTMLElement).querySelector('.ix-todo-item__text') as HTMLElement
    )

    expect(document.querySelectorAll('.ix-todo-item--editing')).toHaveLength(1)
  })
})

/** What the add box makes of the words it is given, and what it shows before it acts on them. */
describe('TodoView add box', () => {
  // 2026-08-07 is a Friday, so every relative wording below is read against that day.
  const FRIDAY = '2026-08-07'

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 7, 12))
    mocked.list.mockResolvedValue({ open: [], done: [] })
    mocked.add.mockReset()
    useTodoStore.setState({
      status: 'ready',
      error: null,
      open: [],
      done: [],
      showDone: false,
      pendingFocusId: null
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    useTodoStore.setState({ status: 'idle', open: [], done: [], pendingFocusId: null })
  })

  const mount = async (): Promise<HTMLElement> => {
    await act(async () => {
      render(<TodoView />)
    })
    return screen.getByPlaceholderText('Add a task… (Enter)')
  }

  /** The hint's text, or null when the line itself is missing from the page. */
  const hint = (): string | null =>
    document.querySelector('.ix-todo__add-hint')?.textContent ?? null

  test('a trailing date word becomes the due day and leaves the title', async () => {
    const input = await mount()

    fireEvent.change(input, { target: { value: 'call the vendor tomorrow' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(mocked.add).toHaveBeenCalledWith('call the vendor', '2026-08-08')
  })

  test('the whole grammar reaches the add box, not just the words it used to know', async () => {
    const input = await mount()

    fireEvent.change(input, { target: { value: 'ship the release 3d' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(mocked.add).toHaveBeenCalledWith('ship the release', '2026-08-10')
  })

  test('the hint shows the title and the day before Enter is pressed', async () => {
    const input = await mount()

    fireEvent.change(input, { target: { value: 'call the vendor tomorrow' } })

    expect(hint()).toContain('call the vendor')
    expect(hint()).toContain('due tomorrow')
  })

  test('the hint keeps its line whether or not a day was read, so the list holds still', async () => {
    const input = await mount()

    // "thu" names a day, "thur" names none, "thursday" names one again. The line stays either
    // way, so spelling the word out does not shove the task list up and down under the cursor.
    expect(hint()).toBe('')

    fireEvent.change(input, { target: { value: 'standup thu' } })
    expect(hint()).toContain('standup')

    fireEvent.change(input, { target: { value: 'standup thur' } })
    expect(hint()).toBe('')

    fireEvent.change(input, { target: { value: 'standup thursday' } })
    expect(hint()).toContain('standup')
  })

  test('text that names no day stays whole and raises no hint', async () => {
    const input = await mount()

    fireEvent.change(input, { target: { value: 'tomorrow is the deadline' } })
    expect(hint()).toBe('')

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(mocked.add).toHaveBeenCalledWith('tomorrow is the deadline', null)
  })

  test('a task that is only a date word keeps its text and gets no due day', async () => {
    const input = await mount()

    fireEvent.change(input, { target: { value: 'tomorrow' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(mocked.add).toHaveBeenCalledWith('tomorrow', null)
  })

  test('a picked date wins, and its presence leaves every word in the title', async () => {
    const input = await mount()

    fireEvent.click(screen.getByTitle('Add due date'))
    fireEvent.change(document.querySelector('.ix-todo__date') as HTMLElement, {
      target: { value: FRIDAY }
    })
    fireEvent.change(input, { target: { value: 'call the vendor tomorrow' } })

    // Nothing is being guessed while an explicit day is standing, so nothing is announced either.
    expect(hint()).toBe('')

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(mocked.add).toHaveBeenCalledWith('call the vendor tomorrow', FRIDAY)
  })
})

/** The menu a row raises at the pointer, and the one thing it can do that the row cannot. */
describe('TodoView task menu', () => {
  const clipboard = { writeText: vi.fn<(text: string) => Promise<void>>() }

  beforeEach(() => {
    vi.useFakeTimers()
    clipboard.writeText.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
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

  const menuLabels = (): string[] =>
    screen.queryAllByRole('menuitem').map((item) => item.textContent ?? '')

  const rightClick = (text: string): void => {
    fireEvent.contextMenu(rowOf(text) as HTMLElement, { clientX: 40, clientY: 60 })
  }

  test('a right-click raises the row’s whole repertoire at the pointer', async () => {
    await mount()

    rightClick('Task b')

    expect(menuLabels()).toEqual(['Start session', 'Copy task', 'Edit', 'Delete'])
  })

  test('the menu says which task it addresses by selecting that row', async () => {
    await mount()

    rightClick('Task b')

    expect(rowOf('Task b')?.className).toContain('ix-todo-item--selected')
  })

  test('Copy puts the task on the clipboard and closes the menu', async () => {
    await mount()

    rightClick('Task b')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy task' }))

    expect(clipboard.writeText).toHaveBeenCalledWith('Task b')
    expect(menuLabels()).toEqual([])
  })

  test('Start session from the menu launches that task', async () => {
    const launch = vi.mocked(launchFromTodoTask)
    launch.mockReset()
    await mount()

    rightClick('Task b')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start session' }))

    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch.mock.calls[0][0].id).toBe('b')
  })

  test('Edit from the menu opens the inline editor and drops the selection', async () => {
    await mount()

    rightClick('Task b')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))

    expect(document.querySelectorAll('.ix-todo-item--editing')).toHaveLength(1)
    expect(document.querySelectorAll('.ix-todo-item--selected')).toHaveLength(0)
  })

  test('Delete from the menu removes that task', async () => {
    await mount()

    rightClick('Task b')
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    })

    expect(mocked.remove).toHaveBeenCalledWith('b')
  })

  test('a done task’s menu keeps only what still applies to it', async () => {
    await mount()

    rightClick('Task z')

    expect(menuLabels()).toEqual(['Copy task', 'Delete'])
  })

  test('the action bar’s overflow carries the copy alone, never a second set of its own buttons', async () => {
    await mount()

    fireEvent.click(within(rowOf('Task b') as HTMLElement).getByRole('button', { name: 'More actions' }))

    expect(menuLabels()).toEqual(['Copy task'])
  })
})
