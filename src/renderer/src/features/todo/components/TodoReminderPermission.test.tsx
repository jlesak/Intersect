import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { TodoTask } from '@common/domain'
import type { TodoReminderPermission } from '@common/ipc'

vi.mock('../ipc')
vi.mock('@renderer/features/workItems', () => ({ launchFromTodoTask: vi.fn() }))
import * as api from '../ipc'
import { useTodoStore } from '../store'
import { useReminderPermissionStore } from '../reminderPermission'
import { useToastStore } from '@renderer/shared/ui/toast'
import { TodoView } from './TodoView'

const mocked = vi.mocked(api)
const timed: TodoTask = { id: 'timed', text: 'Timed task', description: '', dueDay: '2020-01-01',
  dueTime: '12:30', doneAt: null, priority: 4, size: null, sortOrder: 0, projectId: null,
  tagIds: [], recurrence: null, revision: 0 }
const banner = () => screen.queryByText(/TODO reminders are blocked by macOS/)
const mount = async () => {
  let result: ReturnType<typeof render>
  await act(async () => { result = render(<TodoView />) })
  return result!
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  useReminderPermissionStore.setState({ permission: 'unknown', dismissed: false })
  useToastStore.setState({ toasts: [] })
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  mocked.getReminderPermission.mockResolvedValue('denied')
  mocked.list.mockResolvedValue({ open: [timed], done: [] })
  mocked.listProjects.mockResolvedValue([])
  mocked.listTags.mockResolvedValue([])
  mocked.listFilters.mockResolvedValue([])
  mocked.query.mockResolvedValue({ status: 'valid', tasks: [] })
  useTodoStore.setState({ status: 'idle', open: [], done: [], view: 'inbox', projects: [],
    tags: [], filters: [], planningReady: false, showDone: false, pendingFocusId: null,
    activeProjectId: null, activeFilterId: null, queryTasks: [], invalidFilter: false })
})
afterEach(() => { vi.useRealTimers() })

describe('TODO reminder permission', () => {
  test('denied with an overdue timed open task shows the hint and both actions', async () => {
    await mount()
    expect(banner()).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Open notification settings' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDefined()
  })

  test.each<TodoReminderPermission>(['authorized', 'provisional', 'notDetermined', 'unknown',
    'unavailable', 'error'])('does not claim denial for %s', async (status) => {
    mocked.getReminderPermission.mockResolvedValue(status)
    await mount()
    expect(banner()).toBeNull()
  })

  test.each(['inbox', 'today', 'upcoming', 'project', 'filter'] as const)(
    'uses all open tasks in the %s view', async (view) => {
      mocked.list.mockResolvedValue({ open: [{ ...timed, projectId: 'elsewhere' }], done: [] })
      useTodoStore.setState({ view, activeProjectId: 'selected' })
      await mount()
      expect(banner()).not.toBeNull()
    })

  test.each([[], [{ ...timed, dueTime: null }], [{ ...timed, dueDay: null }],
    [{ ...timed, doneAt: 123 }]].map((open) => [open]))('does not show without a timed open task (%j)', async (open) => {
    mocked.list.mockResolvedValue({ open, done: [{ ...timed, doneAt: 123 }] })
    await mount()
    expect(banner()).toBeNull()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const focus = async () => { await act(async () => { fireEvent(window, new Event('focus')) }) }
const tick = async () => { await act(async () => { vi.advanceTimersByTime(5000) }) }
const permission = async (value: TodoReminderPermission) => {
  mocked.getReminderPermission.mockResolvedValue(value)
  await focus()
}

describe('permission lifecycle and dismissal', () => {
  test('polls the initial decision and grant without focus, including after dismissal', async () => {
    mocked.getReminderPermission.mockResolvedValue('notDetermined')
    await mount()
    expect(banner()).toBeNull()
    mocked.getReminderPermission.mockResolvedValue('denied')
    await tick()
    expect(banner()).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    mocked.getReminderPermission.mockResolvedValue('authorized')
    await tick()
    mocked.getReminderPermission.mockResolvedValue('denied')
    await tick()
    expect(banner()).not.toBeNull()
  })

  test('dismissal survives views, remount, task removal and re-addition', async () => {
    const first = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await act(async () => { useTodoStore.getState().setView('upcoming') })
    expect(banner()).toBeNull()
    first.unmount()
    await mount()
    await act(async () => { useTodoStore.setState({ open: [] }) })
    await act(async () => { useTodoStore.setState({ open: [timed] }) })
    await focus()
    expect(banner()).toBeNull()
  })

  test.each<TodoReminderPermission>(['authorized', 'provisional'])(
    'observed %s resets dismissal for the next denial', async (granted) => {
      await mount()
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
      await permission(granted)
      expect(banner()).toBeNull()
      await permission('denied')
      expect(banner()).not.toBeNull()
    })

  test.each<TodoReminderPermission>(['notDetermined', 'unknown', 'unavailable', 'error'])(
    '%s hides a warning but does not reset dismissal', async (value) => {
      await mount()
      await permission(value)
      expect(banner()).toBeNull()
      await permission('denied')
      expect(banner()).not.toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
      await permission(value)
      await permission('denied')
      expect(banner()).toBeNull()
    })

  test('refreshes on focus and visibility, pauses polling while hidden or without a timed task', async () => {
    await mount()
    const beforeFocus = mocked.getReminderPermission.mock.calls.length
    await focus()
    expect(mocked.getReminderPermission).toHaveBeenCalledTimes(beforeFocus + 1)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => { fireEvent(document, new Event('visibilitychange')) })
    const hidden = mocked.getReminderPermission.mock.calls.length
    await tick()
    await focus()
    expect(mocked.getReminderPermission).toHaveBeenCalledTimes(hidden)
    mocked.getReminderPermission.mockResolvedValue('authorized')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    await act(async () => { fireEvent(document, new Event('visibilitychange')) })
    expect(banner()).toBeNull()
    expect(mocked.getReminderPermission).toHaveBeenCalledTimes(hidden + 1)
    await act(async () => { useTodoStore.setState({ open: [] }) })
    const empty = mocked.getReminderPermission.mock.calls.length
    await tick()
    expect(mocked.getReminderPermission).toHaveBeenCalledTimes(empty)
    await act(async () => { useTodoStore.setState({ open: [timed] }) })
    expect(mocked.getReminderPermission).toHaveBeenCalledTimes(empty + 1)
  })

  test('a newer grant wins over an older denied response', async () => {
    useTodoStore.setState({ open: [timed] })
    const old = deferred<TodoReminderPermission>()
    mocked.getReminderPermission.mockReturnValueOnce(old.promise)
    await mount()
    await permission('authorized')
    await act(async () => { old.resolve('denied') })
    expect(banner()).toBeNull()
    expect(useReminderPermissionStore.getState().permission).toBe('authorized')
  })

  test('unmount removes timers/listeners and prevents old results overwriting a new instance', async () => {
    useTodoStore.setState({ open: [timed] })
    const old = deferred<TodoReminderPermission>()
    mocked.getReminderPermission.mockReturnValueOnce(old.promise)
    const first = await mount()
    first.unmount()
    const calls = mocked.getReminderPermission.mock.calls.length
    await focus()
    await tick()
    expect(mocked.getReminderPermission).toHaveBeenCalledTimes(calls)
    mocked.getReminderPermission.mockResolvedValue('authorized')
    await mount()
    await act(async () => { old.resolve('denied') })
    expect(banner()).toBeNull()
    expect(useReminderPermissionStore.getState().permission).toBe('authorized')
  })

  test('a rejected permission request hides denial, adds no toast, and recovers on focus', async () => {
    await mount()
    mocked.getReminderPermission.mockRejectedValue(new Error('Transport failed'))
    await focus()
    expect(banner()).toBeNull()
    expect(useToastStore.getState().toasts).toEqual([])
    await permission('denied')
    expect(banner()).not.toBeNull()
  })

  test('settings success leaves the warning until a permission read, failure gives manual path', async () => {
    await mount()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open notification settings' })) })
    expect(mocked.openReminderSettings).toHaveBeenCalledTimes(1)
    expect(banner()).not.toBeNull()
    mocked.openReminderSettings.mockRejectedValue(new Error('Cannot open'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open notification settings' })) })
    expect(useToastStore.getState().toasts).toHaveLength(1)
    expect(useToastStore.getState().toasts[0].message).toContain('System Settings → Notifications → Intersect')
    expect(banner()).not.toBeNull()
    fireEvent.change(screen.getByPlaceholderText('Add a task… (Enter)'), { target: { value: 'Still usable' } })
    await act(async () => { fireEvent.keyDown(screen.getByPlaceholderText('Add a task… (Enter)'), { key: 'Enter' }) })
    expect(mocked.add).toHaveBeenCalledWith(expect.objectContaining({ text: 'Still usable' }))
  })

  test('grant and read failure preserve both an add draft and an open editor', async () => {
    await mount()
    fireEvent.change(screen.getByPlaceholderText('Add a task… (Enter)'), { target: { value: 'New draft' } })
    fireEvent.click(screen.getByTitle('Edit'))
    fireEvent.change(screen.getByPlaceholderText('Task'), { target: { value: 'Edit draft' } })
    await permission('authorized')
    mocked.getReminderPermission.mockRejectedValue(new Error('Transport failed'))
    await focus()
    expect(screen.getByPlaceholderText('Add a task… (Enter)')).toHaveProperty('value', 'New draft')
    expect(screen.getByPlaceholderText('Task')).toHaveProperty('value', 'Edit draft')
  })
})

describe('task operations remain independent of permission', () => {
  test.each(['denied', 'authorized', 'provisional', 'notDetermined', 'unknown', 'unavailable',
    'error', 'rejected', 'pending'] as const)('create/edit/reorder/complete/reopen/delete with %s', async (state) => {
    if (state === 'pending') mocked.getReminderPermission.mockReturnValue(new Promise(() => {}))
    else if (state === 'rejected') mocked.getReminderPermission.mockRejectedValue(new Error('Offline'))
    else mocked.getReminderPermission.mockResolvedValue(state)
    let tasks: TodoTask[] = []
    mocked.list.mockImplementation(async () => ({ open: tasks.filter((t) => t.doneAt === null),
      done: tasks.filter((t) => t.doneAt !== null) }))
    mocked.add.mockImplementation(async (input) => {
      const task = { ...timed, id: String(tasks.length), ...(typeof input === 'string' ? { text: input } : input) }
      tasks.push(task)
      return task
    })
    mocked.update.mockImplementation(async (id, patch) => {
      tasks = tasks.map((t) => t.id === id ? { ...t, ...patch } : t)
      return tasks.find((t) => t.id === id)!
    })
    mocked.complete.mockImplementation(async (id) => {
      tasks = tasks.map((t) => t.id === id ? { ...t, doneAt: 123 } : t)
      return { status: 'completed', task: tasks.find((t) => t.id === id)! }
    })
    mocked.setDone.mockImplementation(async (id) => {
      tasks = tasks.map((t) => t.id === id ? { ...t, doneAt: null } : t)
      return tasks.find((t) => t.id === id)!
    })
    mocked.remove.mockImplementation(async (id) => { tasks = tasks.filter((t) => t.id !== id) })
    mocked.reorder.mockImplementation(async (ids) => {
      tasks = ids.map((id) => tasks.find((t) => t.id === id)!)
      return tasks
    })
    await mount()
    const store = useTodoStore.getState()
    await act(async () => { expect(await store.add({ text: 'First', dueDay: '2020-01-01', dueTime: '12:30' })).toBe(true) })
    expect(screen.getByText('First')).toBeDefined()
    expect(Boolean(banner())).toBe(state === 'denied')
    await act(async () => { expect(await store.update('0', { text: 'Edited', dueTime: null })).toBe(true) })
    expect(screen.getByText('Edited')).toBeDefined()
    expect(banner()).toBeNull()
    await act(async () => { await store.update('0', { dueTime: '13:00' }) })
    expect(Boolean(banner())).toBe(state === 'denied')
    await act(async () => { await store.add({ text: 'Second', dueDay: '2020-01-01', dueTime: null }) })
    await act(async () => { await store.reorder(['1', '0']) })
    expect([...document.querySelectorAll('.ix-todo-item__text')].map((el) => el.textContent))
      .toEqual(['Second', 'Edited'])
    expect(mocked.reorder).toHaveBeenCalledWith(['1', '0'])
    await act(async () => { await store.toggleDone('0', true) })
    expect(banner()).toBeNull()
    expect(screen.queryByText('Edited')).toBeNull()
    await act(async () => { await store.toggleDone('0', false) })
    expect(screen.getByText('Edited')).toBeDefined()
    expect(Boolean(banner())).toBe(state === 'denied')
    await act(async () => { await store.remove('0') })
    expect(banner()).toBeNull()
    expect(screen.queryByText('Edited')).toBeNull()
    expect(screen.getByText('Second')).toBeDefined()
    expect(useTodoStore.getState().status).toBe('ready')
    expect(useToastStore.getState().toasts).toEqual([])
  })
})
