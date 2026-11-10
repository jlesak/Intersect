import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { TodoTask } from '@common/domain'
import { dayKeyOf } from '@common/week'

vi.mock('../ipc')
vi.mock('@renderer/features/workItems', () => ({ launchFromTodoTask: vi.fn() }))
import * as api from '../ipc'
import { useTodoStore } from '../store'
import { TodoView } from './TodoView'
import { SidebarTodo } from './SidebarTodo'

const mocked = vi.mocked(api)
const today = '2026-11-10'
const tomorrow = '2026-11-11'
const make = (id: string, dueDay: string, projectId: string | null = null): TodoTask => ({
  id, text: `Task ${id}`, description: '', dueDay, dueTime: null, priority: 4,
  size: null, sortOrder: 0, doneAt: null, projectId, tagIds: [], recurrence: null, revision: 0
})
const a = make('a', today)
const b = make('b', tomorrow)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 10, 23, 59, 30))
  vi.clearAllMocks()
  mocked.list.mockResolvedValue({ open: [a, b], done: [] })
  mocked.listProjects.mockResolvedValue([])
  mocked.listTags.mockResolvedValue([])
  mocked.listFilters.mockResolvedValue([])
  mocked.query.mockImplementation(async (_query, day) => ({ status: 'valid',
    tasks: [a, b].filter((task) => task.dueDay! <= day) }))
  useTodoStore.setState({ status: 'ready', open: [a, b], done: [], showDone: false,
    pendingFocusId: null, view: 'today', activeProjectId: null, activeFilterId: null,
    projects: [], tags: [], filters: [], queryTasks: [], invalidFilter: false,
    dayKey: today, missingTask: false })
})
afterEach(() => { vi.useRealTimers() })

describe('mounted Today view', () => {
  test('a stale visible recurring row cannot complete the next occurrence', async () => {
    const recurring = { ...a, recurrence: { mode: 'fixed' as const, unit: 'day' as const,
      interval: 1, anchorDay: today } }
    let serverRevision = 0
    let historyCount = 0
    mocked.list.mockResolvedValue({ open: [recurring], done: [] })
    mocked.query.mockResolvedValue({ status: 'valid', tasks: [recurring] })
    mocked.complete.mockImplementation(async (_id, expectedRevision) => {
      if (expectedRevision !== serverRevision) return { status: 'stale', task: {
        ...recurring, revision: serverRevision, dueDay: tomorrow } }
      serverRevision += 1
      historyCount += 1
      return { status: 'completed', task: { ...recurring, revision: serverRevision,
        dueDay: tomorrow } }
    })
    useTodoStore.setState({ open: [recurring] })
    await act(async () => { render(<TodoView />) })
    mocked.list.mockImplementation(async () => ({ open: [{ ...recurring,
      revision: serverRevision, dueDay: tomorrow }], done: [] }))
    mocked.query.mockImplementation(() => new Promise(() => {}))
    await act(async () => { fireEvent.click(screen.getByTitle('Mark as done')) })
    expect(useTodoStore.getState().open[0].revision).toBe(1)
    expect(useTodoStore.getState().queryTasks[0].revision).toBe(0)
    await act(async () => { fireEvent.click(screen.getByTitle('Mark as done')) })
    expect(mocked.complete.mock.calls.map((call) => call[1])).toEqual([0, 0])
    expect(historyCount).toBe(1)
  })

  test('same-day focus refresh keeps unsaved task edits', async () => {
    mocked.list.mockResolvedValue({ open: [a], done: [] })
    mocked.query.mockImplementation(async () => ({ status: 'valid', tasks: [{ ...a }] }))
    useTodoStore.setState({ open: [a] })
    await act(async () => { render(<TodoView />) })
    fireEvent.click(screen.getByTitle('Edit'))
    fireEvent.change(screen.getByPlaceholderText('Task'), { target: { value: 'Unsaved edit' } })
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(screen.getByPlaceholderText('Task')).toHaveProperty('value', 'Unsaved edit')
  })

  test('deleting a selected tag removes it from creation and a failed add keeps the draft', async () => {
    const tag = { id: 'tag', name: 'Temporary' }
    mocked.listTags.mockResolvedValueOnce([tag]).mockResolvedValueOnce([])
    mocked.removeTag.mockResolvedValue(undefined)
    mocked.add.mockRejectedValue(new Error('Write failed'))
    useTodoStore.setState({ tags: [tag] })
    await act(async () => { render(<TodoView />) })
    fireEvent.click(screen.getByLabelText('Temporary'))
    await act(async () => { fireEvent.click(screen.getByTitle('Delete tag Temporary')) })
    const input = screen.getByPlaceholderText('Add a task… (Enter)')
    fireEvent.change(input, { target: { value: 'Keep my draft' } })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(mocked.add).toHaveBeenCalledWith(expect.objectContaining({ tagIds: [] }))
    expect(input).toHaveProperty('value', 'Keep my draft')
  })

  test('moves to the new local day while mounted and rechecks on focus after sleep', async () => {
    await act(async () => { render(<TodoView />) })
    expect(screen.getByText('Task a')).toBeTruthy()
    expect(screen.queryByText('Task b')).toBeNull()
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(dayKeyOf(Date.now())).toBe(tomorrow)
    expect(screen.getByText('Task b')).toBeTruthy()
    const calls = mocked.query.mock.calls.length
    vi.setSystemTime(new Date(2026, 10, 12, 9))
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(mocked.query.mock.calls.length).toBeGreaterThan(calls)
    expect(useTodoStore.getState().dayKey).toBe('2026-11-12')
    const input = screen.getByPlaceholderText('Add a task… (Enter)')
    fireEvent.change(input, { target: { value: 'after sleep' } })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(mocked.add).toHaveBeenCalledWith(expect.objectContaining({
      text: 'after sleep', dueDay: '2026-11-12' }))
  })

  test('older async query cannot replace result after midnight', async () => {
    let resolveOld!: (value: { status: 'valid'; tasks: TodoTask[] }) => void
    let resolveNew!: (value: { status: 'valid'; tasks: TodoTask[] }) => void
    mocked.query.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveNew = resolve }))
    const old = useTodoStore.getState().refreshView(today)
    const next = useTodoStore.getState().refreshView(tomorrow)
    resolveNew({ status: 'valid', tasks: [b] })
    await next
    resolveOld({ status: 'valid', tasks: [a] })
    await old
    expect(useTodoStore.getState().queryTasks.map((task) => task.id)).toEqual(['b'])
  })
})

describe('filter and cross-surface focus', () => {
  test('a saved Today filter changes with the local day and rechecks on focus', async () => {
    const filter = { id: 'today-filter', name: 'Today only',
      query: { version: 1 as const, date: 'today' as const }, validity: 'valid' as const,
      missingReferences: [] }
    mocked.listFilters.mockResolvedValue([filter])
    mocked.query.mockImplementation(async (_query, day) => ({ status: 'valid',
      tasks: [a, b].filter((task) => task.dueDay === day) }))
    useTodoStore.setState({ view: 'filter', activeFilterId: filter.id, filters: [filter] })
    await act(async () => { render(<TodoView />) })
    expect(screen.getByText('Task a')).toBeTruthy()
    expect(screen.queryByText('Task b')).toBeNull()
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(screen.queryByText('Task a')).toBeNull()
    expect(screen.getByText('Task b')).toBeTruthy()
    const calls = mocked.query.mock.calls.length
    vi.setSystemTime(new Date(2026, 10, 12, 9))
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(mocked.query.mock.calls.length).toBeGreaterThan(calls)
    expect(screen.queryByText('Task b')).toBeNull()
  })

  test('switching saved filters closes the editor before it can save to another filter', async () => {
    const filterA = { id: 'a', name: 'Filter A', query: { version: 1 as const,
      date: 'today' as const }, validity: 'valid' as const, missingReferences: [] }
    const filterB = { id: 'b', name: 'Filter B', query: { version: 1 as const,
      date: 'overdue' as const }, validity: 'valid' as const, missingReferences: [] }
    mocked.listFilters.mockResolvedValue([filterA, filterB])
    useTodoStore.setState({ view: 'filter', activeFilterId: 'a', filters: [filterA, filterB] })
    await act(async () => { render(<><SidebarTodo /><TodoView /></>) })
    fireEvent.click(screen.getByRole('button', { name: 'Edit filter' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter name' }),
      { target: { value: 'A edited' } })
    fireEvent.click(screen.getByRole('button', { name: 'Filter B' }))
    expect(screen.queryByRole('textbox', { name: 'Filter name' })).toBeNull()
    expect(mocked.updateFilter).not.toHaveBeenCalled()
  })

  test('deleted filter reference shows warning and edit without ordinary empty results', async () => {
    const filter = { id: 'f', name: 'Planning', query: { version: 1 as const,
      projects: ['deleted'] }, validity: 'missingReferences' as const,
      missingReferences: ['project' as const] }
    mocked.listFilters.mockResolvedValue([filter])
    mocked.query.mockResolvedValue({ status: 'invalid', missingReferences: ['project'] })
    useTodoStore.setState({ view: 'filter', activeFilterId: 'f', filters: [filter] })
    await act(async () => { render(<TodoView />) })
    expect(screen.getByRole('alert').textContent).toContain('Filtr odkazuje na smazaný projekt')
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Open tasks' })).toBeNull()
  })

  test('focus from excluding filter switches to owning project and marks row after render', async () => {
    const projectTask = make('project', today, 'p')
    mocked.getById.mockResolvedValue(projectTask)
    mocked.list.mockResolvedValue({ open: [projectTask], done: [] })
    mocked.listProjects.mockResolvedValue([{ id: 'p', name: 'Build', sortOrder: 0 }])
    useTodoStore.setState({ view: 'filter', activeFilterId: 'f', queryTasks: [] })
    await act(async () => { render(<TodoView />) })
    await act(async () => { useTodoStore.getState().focusTask('project') })
    expect(useTodoStore.getState().view).toBe('project')
    expect(screen.getByText('Task project').closest('.ix-todo-item')?.className)
      .toContain('ix-todo-item--focused')
    expect(useTodoStore.getState().pendingFocusId).toBeNull()
  })

  test('a missing focus target is announced and a completed one-off opens Done', async () => {
    mocked.getById.mockResolvedValueOnce(undefined)
    await act(async () => { render(<TodoView />) })
    await act(async () => { useTodoStore.getState().focusTask('removed') })
    expect(screen.getByText('Task no longer exists.')).toBeTruthy()
    const completed = { ...a, doneAt: 100 }
    mocked.getById.mockResolvedValueOnce(completed)
    mocked.list.mockResolvedValue({ open: [], done: [completed] })
    useTodoStore.setState({ view: 'filter', queryTasks: [], activeFilterId: 'other' })
    await act(async () => {
      useTodoStore.setState({ pendingFocusId: completed.id })
      await useTodoStore.getState().resolveFocus(completed.id)
    })
    expect(useTodoStore.getState().view).toBe('inbox')
    expect(useTodoStore.getState().showDone).toBe(true)
    expect(screen.getByRole('list', { name: 'Done tasks' }).textContent).toContain('Task a')
    expect(useTodoStore.getState().pendingFocusId).toBeNull()
  })
})
