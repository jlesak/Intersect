import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { TodoTask } from '@common/domain'
import { dayKeyOf } from '@common/week'

vi.mock('../ipc')
vi.mock('@renderer/features/workItems', () => ({ launchFromTodoTask: vi.fn() }))
import * as api from '../ipc'
import { useToastStore } from '@renderer/shared/ui/toast'
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
  mocked.update.mockReset()
  mocked.list.mockResolvedValue({ open: [a, b], done: [] })
  mocked.listProjects.mockResolvedValue([])
  mocked.listTags.mockResolvedValue([])
  mocked.listFilters.mockResolvedValue([])
  mocked.query.mockImplementation(async (_query, day) => ({ status: 'valid',
    tasks: [a, b].filter((task) => task.dueDay! <= day) }))
  useTodoStore.setState({ status: 'ready', open: [a, b], done: [], showDone: false,
    pendingFocusId: null, view: 'today', activeProjectId: null, activeFilterId: null,
    projects: [], tags: [], filters: [], planningReady: false, queryTasks: [],
    invalidFilter: false, dayKey: today, missingTask: false })
})
afterEach(() => { vi.useRealTimers() })

describe('mounted Today view', () => {
  test('deleting a tag during an edit keeps the draft and saves without the deleted ID', async () => {
    const tag = { id: 'tag', name: 'Temporary' }
    let canonical = { ...a, tagIds: [tag.id] }
    mocked.list.mockImplementation(async () => ({ open: [{ ...canonical }], done: [] }))
    mocked.query.mockImplementation(async () => ({ status: 'valid', tasks: [{ ...canonical }] }))
    mocked.listTags.mockResolvedValueOnce([tag]).mockResolvedValueOnce([])
    mocked.removeTag.mockImplementation(async () => { canonical = { ...canonical, tagIds: [] } })
    mocked.update.mockImplementation(async (_id, patch) => {
      if (patch.tagIds?.includes(tag.id)) throw new Error('Deleted tag ID')
      canonical = { ...canonical, ...patch }
      return canonical
    })
    useTodoStore.setState({ open: [canonical], tags: [tag] })
    await act(async () => { render(<TodoView />) })
    fireEvent.click(screen.getByTitle('Edit'))
    fireEvent.change(screen.getByPlaceholderText('Task'), { target: { value: 'Keep this edit' } })
    await act(async () => { fireEvent.click(screen.getByTitle('Delete tag Temporary')) })
    expect(screen.getByPlaceholderText('Task')).toHaveProperty('value', 'Keep this edit')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(mocked.update).toHaveBeenCalledWith(a.id,
      expect.objectContaining({ text: 'Keep this edit', tagIds: [] }))
    expect(screen.queryByPlaceholderText('Task')).toBeNull()
  })

  test('a rejected task edit stays open with its draft for retry', async () => {
    mocked.list.mockResolvedValue({ open: [a], done: [] })
    mocked.query.mockResolvedValue({ status: 'valid', tasks: [{ ...a }] })
    mocked.update.mockRejectedValueOnce(new Error('Write failed'))
      .mockResolvedValueOnce({ ...a, text: 'Retry this edit' })
    useTodoStore.setState({ open: [a] })
    await act(async () => { render(<TodoView />) })
    fireEvent.click(screen.getByTitle('Edit'))
    fireEvent.change(screen.getByPlaceholderText('Task'), { target: { value: 'Retry this edit' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(screen.getByPlaceholderText('Task')).toHaveProperty('value', 'Retry this edit')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(mocked.update).toHaveBeenCalledTimes(2)
    expect(screen.queryByPlaceholderText('Task')).toBeNull()
  })

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

describe('drafts that reference projects and tags', () => {
  const tag = { id: 'tag-1', name: 'Focus' }
  const build = { id: 'p', name: 'Build', sortOrder: 0 }
  const ship = { id: 'q', name: 'Ship', sortOrder: 1 }

  /** Serves one task as main would: every read answers a fresh copy of the canonical row. */
  function serve(task: TodoTask): { get(): TodoTask; set(next: TodoTask): void } {
    let canonical = { ...task }
    mocked.list.mockImplementation(async () => ({ open: [{ ...canonical }], done: [] }))
    mocked.query.mockImplementation(async () => ({ status: 'valid', tasks: [{ ...canonical }] }))
    mocked.update.mockImplementation(async (_id, patch) => {
      if (patch.projectId && patch.projectId !== build.id && patch.projectId !== ship.id)
        throw new Error('TODO project not found')
      canonical = { ...canonical, ...patch }
      return { ...canonical }
    })
    useTodoStore.setState({ open: [{ ...task }] })
    return { get: () => canonical, set: (next) => { canonical = next } }
  }

  async function editAndType(text: string): Promise<void> {
    fireEvent.click(screen.getByTitle('Edit'))
    fireEvent.change(screen.getByPlaceholderText('Task'), { target: { value: text } })
  }

  test('saving after the task list but before tag metadata keeps the task tags', async () => {
    serve({ ...a, tagIds: [tag.id] })
    mocked.listTags.mockReturnValue(new Promise(() => {}))
    await act(async () => { render(<TodoView />) })
    await editAndType('Edited early')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(mocked.update).toHaveBeenCalledWith(a.id,
      expect.objectContaining({ text: 'Edited early', tagIds: [tag.id] }))
  })

  test('a failed metadata load keeps the project and tags of a saved task', async () => {
    serve({ ...a, projectId: build.id, tagIds: [tag.id] })
    mocked.listProjects.mockRejectedValue(new Error('Metadata offline'))
    await act(async () => { render(<TodoView />) })
    await editAndType('Edited offline')
    expect(screen.getByLabelText('TODO project')).toHaveProperty('value', build.id)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(mocked.update).toHaveBeenCalledWith(a.id, expect.objectContaining({
      text: 'Edited offline', projectId: build.id, tagIds: [tag.id] }))
  })

  test('deleting the only project during a Today edit saves the task to Inbox', async () => {
    const server = serve({ ...a, projectId: build.id })
    mocked.listProjects.mockResolvedValueOnce([build]).mockResolvedValue([])
    mocked.removeProject.mockImplementationOnce(async () => {
      server.set({ ...server.get(), projectId: null })
    })
    await act(async () => { render(<><SidebarTodo /><TodoView /></>) })
    await editAndType('Keep this edit')
    await act(async () => { fireEvent.click(screen.getByTitle('Delete Build')) })
    expect(screen.getByPlaceholderText('Task')).toHaveProperty('value', 'Keep this edit')
    expect(screen.getByLabelText('TODO project')).toHaveProperty('value', '')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(mocked.update).toHaveBeenLastCalledWith(a.id,
      expect.objectContaining({ text: 'Keep this edit', projectId: null }))
    expect(screen.queryByPlaceholderText('Task')).toBeNull()
  })

  test('deleting the only project during an Upcoming edit saves the task to Inbox', async () => {
    const server = serve({ ...a, projectId: build.id })
    mocked.listProjects.mockResolvedValueOnce([build]).mockResolvedValue([])
    mocked.removeProject.mockImplementationOnce(async () => {
      server.set({ ...server.get(), projectId: null })
    })
    useTodoStore.setState({ view: 'upcoming' })
    await act(async () => { render(<><SidebarTodo /><TodoView /></>) })
    fireEvent.click(screen.getByTitle('Task a'))
    fireEvent.change(screen.getByPlaceholderText('Task'), { target: { value: 'Keep this edit' } })
    await act(async () => { fireEvent.click(screen.getByTitle('Delete Build')) })
    expect(screen.getByLabelText('TODO project')).toHaveProperty('value', '')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(mocked.update).toHaveBeenLastCalledWith(a.id,
      expect.objectContaining({ text: 'Keep this edit', projectId: null }))
    expect(screen.queryByPlaceholderText('Task')).toBeNull()
  })

  test('deleting the open project during an edit there carries the draft to Inbox', async () => {
    const server = serve({ ...a, projectId: build.id })
    mocked.listProjects.mockResolvedValueOnce([build]).mockResolvedValue([])
    mocked.removeProject.mockImplementationOnce(async () => {
      server.set({ ...server.get(), projectId: null })
    })
    useTodoStore.setState({ view: 'project', activeProjectId: build.id })
    await act(async () => { render(<><SidebarTodo /><TodoView /></>) })
    await editAndType('Keep this edit')
    await act(async () => { fireEvent.click(screen.getByTitle('Delete Build')) })
    expect(useTodoStore.getState().view).toBe('inbox')
    expect(screen.getByPlaceholderText('Task')).toHaveProperty('value', 'Keep this edit')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(mocked.update).toHaveBeenLastCalledWith(a.id,
      expect.objectContaining({ text: 'Keep this edit', projectId: null }))
    expect(screen.queryByPlaceholderText('Task')).toBeNull()
  })

  test('deleting the project picked as a move target keeps the task in its own project', async () => {
    serve({ ...a, projectId: build.id })
    mocked.listProjects.mockResolvedValueOnce([build, ship]).mockResolvedValue([build])
    mocked.removeProject.mockImplementationOnce(async () => {})
    await act(async () => { render(<><SidebarTodo /><TodoView /></>) })
    await editAndType('Move me')
    fireEvent.change(screen.getByLabelText('TODO project'), { target: { value: ship.id } })
    await act(async () => { fireEvent.click(screen.getByTitle('Delete Ship')) })
    expect(screen.getByLabelText('TODO project')).toHaveProperty('value', build.id)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(mocked.update).toHaveBeenLastCalledWith(a.id,
      expect.objectContaining({ text: 'Move me', projectId: build.id }))
    expect(screen.queryByPlaceholderText('Task')).toBeNull()
  })

  test('an older metadata response cannot bring back a tag deleted during an edit', async () => {
    const server = serve({ ...a, tagIds: [tag.id] })
    let answerFirstLoad!: (tags: typeof tag[]) => void
    mocked.listTags.mockReturnValueOnce(new Promise((resolve) => { answerFirstLoad = resolve }))
      .mockResolvedValue([])
    mocked.removeTag.mockImplementationOnce(async () => {
      server.set({ ...server.get(), tagIds: [] })
    })
    mocked.update.mockImplementation(async (_id, patch) => {
      if (patch.tagIds?.includes(tag.id)) throw new Error('TODO tag not found')
      return { ...server.get(), ...patch }
    })
    useTodoStore.setState({ tags: [tag], planningReady: true })
    await act(async () => { render(<TodoView />) })
    await editAndType('Keep this edit')
    await act(async () => { fireEvent.click(screen.getByTitle('Delete tag Focus')) })
    await act(async () => { answerFirstLoad([tag]) })
    expect(useTodoStore.getState().tags).toEqual([])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(mocked.update).toHaveBeenLastCalledWith(a.id,
      expect.objectContaining({ text: 'Keep this edit', tagIds: [] }))
  })

  test('a deleted tag leaves the draft even when the metadata reload fails', async () => {
    const server = serve({ ...a, tagIds: [tag.id] })
    mocked.listTags.mockResolvedValueOnce([tag]).mockRejectedValue(new Error('Reload failed'))
    mocked.removeTag.mockImplementationOnce(async () => {
      server.set({ ...server.get(), tagIds: [] })
    })
    mocked.update.mockImplementation(async (_id, patch) => {
      if (patch.tagIds?.includes(tag.id)) throw new Error('TODO tag not found')
      return { ...server.get(), ...patch }
    })
    await act(async () => { render(<TodoView />) })
    await editAndType('Keep this edit')
    await act(async () => { fireEvent.click(screen.getByTitle('Delete tag Focus')) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(mocked.update).toHaveBeenLastCalledWith(a.id,
      expect.objectContaining({ text: 'Keep this edit', tagIds: [] }))
    expect(screen.queryByPlaceholderText('Task')).toBeNull()
  })

  test('a filter editor opened before metadata loads does not call references deleted', async () => {
    const filter = { id: 'f', name: 'Build focus', query: { version: 1 as const,
      projects: [build.id], tags: [tag.id] }, validity: 'valid' as const, missingReferences: [] }
    mocked.listProjects.mockReturnValue(new Promise(() => {}))
    useTodoStore.setState({ view: 'filter', activeFilterId: filter.id, filters: [filter] })
    await act(async () => { render(<TodoView />) })
    fireEvent.click(screen.getByRole('button', { name: 'Edit filter' }))
    expect(screen.queryByText(/Deleted/)).toBeNull()
    expect(screen.getByLabelText(/Project not loaded/)).toHaveProperty('checked', true)
    expect(screen.getByLabelText(/Tag not loaded/)).toHaveProperty('checked', true)
  })

  test('a rejected filter save keeps the editor and its draft for retry', async () => {
    mocked.listProjects.mockResolvedValue([build])
    mocked.createFilter.mockRejectedValueOnce(new Error('Write failed'))
      .mockResolvedValueOnce({ id: 'f', name: 'Build only', query: { version: 1,
        projects: [build.id] }, validity: 'valid', missingReferences: [] })
    await act(async () => { render(<TodoView />) })
    fireEvent.click(screen.getByRole('button', { name: 'New filter' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter name' }),
      { target: { value: 'Build only' } })
    fireEvent.click(screen.getByLabelText('Build'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save filter' })) })
    expect(screen.getByRole('textbox', { name: 'Filter name' })).toHaveProperty('value', 'Build only')
    expect(screen.getByLabelText('Build')).toHaveProperty('checked', true)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save filter' })) })
    expect(mocked.createFilter).toHaveBeenLastCalledWith('Build only',
      { version: 1, projects: [build.id] })
    expect(screen.queryByRole('textbox', { name: 'Filter name' })).toBeNull()
  })

  test('a second save of a new filter while the first is in flight saves nothing more', async () => {
    let answer!: () => void
    mocked.createFilter.mockReturnValueOnce(new Promise((resolve) => {
      answer = () => resolve({ id: 'f', name: 'Once', query: { version: 1 }, validity: 'valid',
        missingReferences: [] })
    }))
    await act(async () => { render(<TodoView />) })
    fireEvent.click(screen.getByRole('button', { name: 'New filter' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter name' }),
      { target: { value: 'Once' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save filter' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save filter' })) })
    expect(mocked.createFilter).toHaveBeenCalledTimes(1)
    await act(async () => { answer() })
    expect(screen.queryByRole('textbox', { name: 'Filter name' })).toBeNull()
  })

  test('a second save of an edited filter while the first is in flight saves nothing more', async () => {
    const filter = { id: 'f', name: 'Planning', query: { version: 1 as const },
      validity: 'valid' as const, missingReferences: [] }
    mocked.listFilters.mockResolvedValue([filter])
    let answer!: () => void
    mocked.updateFilter.mockReturnValueOnce(new Promise((resolve) => {
      answer = () => resolve(filter)
    }))
    useTodoStore.setState({ view: 'filter', activeFilterId: filter.id, filters: [filter] })
    await act(async () => { render(<TodoView />) })
    fireEvent.click(screen.getByRole('button', { name: 'Edit filter' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save filter' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save filter' })) })
    expect(mocked.updateFilter).toHaveBeenCalledTimes(1)
    await act(async () => { answer() })
  })

  test('a second rename submit while the first is in flight renames nothing more', async () => {
    mocked.listTags.mockResolvedValue([tag])
    mocked.listProjects.mockResolvedValue([build])
    let answerTag!: () => void
    let answerProject!: () => void
    mocked.updateTag.mockReturnValueOnce(new Promise((resolve) => {
      answerTag = () => resolve({ ...tag, name: 'Deep work' })
    }))
    mocked.updateProject.mockReturnValueOnce(new Promise((resolve) => {
      answerProject = () => resolve({ ...build, name: 'Release' })
    }))
    await act(async () => { render(<><SidebarTodo /><TodoView /></>) })
    fireEvent.click(screen.getByTitle('Rename tag Focus'))
    fireEvent.change(screen.getByLabelText('Rename tag'), { target: { value: 'Deep work' } })
    await act(async () => { fireEvent.submit(screen.getByLabelText('Rename tag')) })
    await act(async () => { fireEvent.submit(screen.getByLabelText('Rename tag')) })
    expect(mocked.updateTag).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTitle('Rename Build'))
    fireEvent.change(screen.getByLabelText('Rename project'), { target: { value: 'Release' } })
    await act(async () => { fireEvent.submit(screen.getByLabelText('Rename project')) })
    await act(async () => { fireEvent.submit(screen.getByLabelText('Rename project')) })
    expect(mocked.updateProject).toHaveBeenCalledTimes(1)
    await act(async () => { answerTag(); answerProject() })
  })

  test('a rejected tag or project rename keeps the typed name for retry', async () => {
    mocked.listTags.mockResolvedValue([tag])
    mocked.listProjects.mockResolvedValue([build])
    mocked.updateTag.mockRejectedValueOnce(new Error('Name taken'))
    mocked.updateProject.mockRejectedValueOnce(new Error('Name taken'))
    await act(async () => { render(<><SidebarTodo /><TodoView /></>) })
    fireEvent.click(screen.getByTitle('Rename tag Focus'))
    fireEvent.change(screen.getByLabelText('Rename tag'), { target: { value: 'Deep work' } })
    await act(async () => { fireEvent.submit(screen.getByLabelText('Rename tag')) })
    expect(screen.getByLabelText('Rename tag')).toHaveProperty('value', 'Deep work')
    fireEvent.click(screen.getByTitle('Rename Build'))
    fireEvent.change(screen.getByLabelText('Rename project'), { target: { value: 'Release' } })
    await act(async () => { fireEvent.submit(screen.getByLabelText('Rename project')) })
    expect(screen.getByLabelText('Rename project')).toHaveProperty('value', 'Release')
  })

  test('done rows name their tags', async () => {
    const finished = { ...a, doneAt: 100, tagIds: [tag.id] }
    mocked.list.mockResolvedValue({ open: [], done: [finished] })
    mocked.listTags.mockResolvedValue([tag])
    useTodoStore.setState({ open: [], done: [finished], showDone: true })
    await act(async () => { render(<TodoView />) })
    const doneList = screen.getByRole('list', { name: 'Done tasks' })
    expect(doneList.textContent).toContain('Focus')
    expect(doneList.textContent).not.toContain(tag.id)
  })
})

describe('lists, ordering and the add row', () => {
  const inboxTask = make('inbox', today)
  const first = { ...make('first', today, 'p'), sortOrder: 0 }
  const second = { ...make('second', today, 'p'), sortOrder: 1 }

  test('a size picked in the task editor is saved', async () => {
    mocked.list.mockResolvedValue({ open: [a], done: [] })
    mocked.query.mockResolvedValue({ status: 'valid', tasks: [{ ...a }] })
    mocked.update.mockImplementation(async (_id, patch) => ({ ...a, ...patch }))
    useTodoStore.setState({ open: [a] })
    await act(async () => { render(<TodoView />) })
    fireEvent.click(screen.getByTitle('Edit'))
    fireEvent.change(screen.getByLabelText('Size'), { target: { value: 'M' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(mocked.update).toHaveBeenCalledWith(a.id, expect.objectContaining({ size: 'M' }))
  })

  test('the keyboard reorders a project while Inbox holds tasks', async () => {
    mocked.list.mockResolvedValue({ open: [inboxTask, first, second], done: [] })
    mocked.listProjects.mockResolvedValue([{ id: 'p', name: 'Build', sortOrder: 0 }])
    mocked.reorder.mockImplementation(async (ids) => ids.map((id, sortOrder) =>
      ({ ...(id === first.id ? first : second), sortOrder })))
    useTodoStore.setState({ view: 'project', activeProjectId: 'p',
      open: [inboxTask, first, second] })
    await act(async () => { render(<TodoView />) })
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('button', { name: /Move Task first/ }), { key: 'ArrowDown' })
    })
    expect(mocked.reorder).toHaveBeenCalledWith([second.id, first.id], 'p')
  })

  test('Inbox shows only tasks without a project', async () => {
    mocked.list.mockResolvedValue({ open: [inboxTask, first], done: [] })
    useTodoStore.setState({ view: 'inbox', open: [inboxTask, first] })
    await act(async () => { render(<TodoView />) })
    expect(screen.getByText('Task inbox')).toBeTruthy()
    expect(screen.queryByText('Task first')).toBeNull()
  })

  test('Today and saved filter rows offer no reorder handle', async () => {
    const filter = { id: 'f', name: 'All', query: { version: 1 as const },
      validity: 'valid' as const, missingReferences: [] }
    mocked.listFilters.mockResolvedValue([filter])
    await act(async () => { render(<TodoView />) })
    expect(screen.getByText('Task a')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Move Task/ })).toBeNull()
    await act(async () => { useTodoStore.getState().setView('filter', filter.id) })
    useTodoStore.setState({ filters: [filter] })
    await act(async () => { await useTodoStore.getState().refreshView() })
    expect(screen.getByText('Task a')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Move Task/ })).toBeNull()
  })

  /** Holds each add open until the test answers it, in the order the adds were sent. */
  function holdAdds(): { texts(): string[]; answer(ok?: boolean): Promise<void> } {
    const pending: { resolve(): void; reject(): void }[] = []
    mocked.add.mockImplementation((input) => new Promise((resolve, reject) => {
      const text = typeof input === 'string' ? input : input.text
      pending.push({ resolve: () => resolve({ ...a, id: text, text }),
        reject: () => reject(new Error('Write failed')) })
    }))
    return {
      texts: () => mocked.add.mock.calls.map(([input]) =>
        typeof input === 'string' ? input : input.text),
      async answer(ok = true) {
        await act(async () => { const next = pending.shift()!; if (ok) next.resolve(); else next.reject() })
      }
    }
  }
  const addBox = (): HTMLElement => screen.getByPlaceholderText('Add a task… (Enter)')
  async function type(text: string, enter = true): Promise<void> {
    fireEvent.change(addBox(), { target: { value: text } })
    if (enter) await act(async () => { fireEvent.keyDown(addBox(), { key: 'Enter' }) })
  }

  test('a task submitted while the previous add is in flight is added after it', async () => {
    const adds = holdAdds()
    await act(async () => { render(<TodoView />) })
    await type('first')
    await type('second')
    await type('third')
    expect(addBox()).toHaveProperty('value', '')
    await adds.answer()
    await adds.answer()
    await adds.answer()
    expect(adds.texts()).toEqual(['first', 'second', 'third'])
  })

  test('text typed while an add is in flight survives that add finishing', async () => {
    const adds = holdAdds()
    await act(async () => { render(<TodoView />) })
    await type('first')
    await type('still typing', false)
    await adds.answer()
    expect(addBox()).toHaveProperty('value', 'still typing')
  })

  test('a double Enter on one draft adds it once', async () => {
    const adds = holdAdds()
    await act(async () => { render(<TodoView />) })
    fireEvent.change(addBox(), { target: { value: 'only once' } })
    await act(async () => {
      fireEvent.keyDown(addBox(), { key: 'Enter' })
      fireEvent.keyDown(addBox(), { key: 'Enter' })
    })
    await adds.answer()
    expect(adds.texts()).toEqual(['only once'])
  })

  test('a failed add returns its draft, but never over a newer one', async () => {
    const adds = holdAdds()
    await act(async () => { render(<TodoView />) })
    fireEvent.change(screen.getByLabelText('New task priority'), { target: { value: '1' } })
    await type('lost write')
    expect(addBox()).toHaveProperty('value', '')
    await adds.answer(false)
    expect(addBox()).toHaveProperty('value', 'lost write')
    expect(screen.getByLabelText('New task priority')).toHaveProperty('value', '1')

    await type('retry')
    await type('newer draft', false)
    await adds.answer(false)
    expect(addBox()).toHaveProperty('value', 'newer draft')
    expect(useToastStore.getState().toasts.map((toast) => toast.message))
      .toContain('Task not added: retry')
  })

  test('adding a repeating task resets the repeat interval with the other fields', async () => {
    mocked.add.mockResolvedValue({ ...a, text: 'Water plants' })
    await act(async () => { render(<TodoView />) })
    fireEvent.change(screen.getByLabelText('New task repeat mode'), { target: { value: 'fixed' } })
    fireEvent.change(screen.getByLabelText('New task repeat unit'), { target: { value: 'week' } })
    fireEvent.change(screen.getByLabelText('New task repeat interval'), { target: { value: '2' } })
    const input = screen.getByPlaceholderText('Add a task… (Enter)')
    fireEvent.change(input, { target: { value: 'Water plants' } })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(mocked.add).toHaveBeenCalledWith(expect.objectContaining({
      recurrence: expect.objectContaining({ interval: 2 }) }))
    fireEvent.change(screen.getByLabelText('New task repeat mode'), { target: { value: 'fixed' } })
    expect(screen.getByLabelText('New task repeat interval')).toHaveProperty('value', '1')
    expect(screen.getByLabelText('New task repeat unit')).toHaveProperty('value', 'day')
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
