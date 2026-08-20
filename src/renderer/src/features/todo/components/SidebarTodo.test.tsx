import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { TodoTask } from '@common/domain'

vi.mock('../ipc')
import { useTodoStore } from '../store'
import { SidebarTodo } from './SidebarTodo'

const task = (id: string, dueDay: string | null): TodoTask => ({
  id,
  text: `Task ${id}`,
  description: '',
  dueDay,
  priority: 4,
  sortOrder: 0,
  doneAt: null
})

const setOpen = (open: TodoTask[]): void => {
  useTodoStore.setState({ status: 'ready', error: null, open, done: [], showDone: false })
}

const lines = (): string[] =>
  [...document.querySelectorAll('.ix-todo-rail__due-line')].map((el) => el.textContent ?? '')

/**
 * The rail's deadline counts. They are the only place in the app that says how much is late
 * without the list being on screen, so they have to be right and they have to keep up.
 */
describe('SidebarTodo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // 2026-08-07 at midday. Overdue, due today and later are all reachable from here.
    vi.setSystemTime(new Date(2026, 7, 7, 12))
  })

  afterEach(() => {
    vi.useRealTimers()
    useTodoStore.setState({ status: 'idle', open: [], done: [] })
  })

  const mount = async (): Promise<void> => {
    await act(async () => {
      render(<SidebarTodo />)
    })
  }

  test('a list with no deadlines says only how much is open', async () => {
    setOpen([task('a', null), task('b', '2026-09-01')])
    await mount()

    expect(document.querySelector('.ix-eyebrow')?.textContent).toBe('2 open tasks')
    expect(lines()).toEqual([])
  })

  test('late work and today’s work are counted apart', async () => {
    setOpen([
      task('a', '2026-08-05'),
      task('b', '2026-08-06'),
      task('c', '2026-08-07'),
      task('d', '2026-08-08'),
      task('e', null)
    ])
    await mount()

    expect(lines()).toEqual(['2 overdue', '1 due today'])
  })

  test('a day that has arrived is due, never yet overdue', async () => {
    setOpen([task('a', '2026-08-07')])
    await mount()

    expect(lines()).toEqual(['1 due today'])
  })

  test('the late count carries the same accent the late rows do', async () => {
    setOpen([task('a', '2026-08-05')])
    await mount()

    expect(document.querySelector('.ix-todo-rail__due-line--overdue')?.textContent).toBe('1 overdue')
  })

  test('the counts follow the tasks as they change', async () => {
    setOpen([task('a', '2026-08-05'), task('b', '2026-08-07')])
    await mount()
    expect(lines()).toEqual(['1 overdue', '1 due today'])

    await act(async () => {
      setOpen([task('b', '2026-08-07')])
    })

    expect(lines()).toEqual(['1 due today'])
  })

  test('a task due tomorrow becomes due today when the day turns', async () => {
    vi.setSystemTime(new Date(2026, 7, 7, 23, 59))
    setOpen([task('a', '2026-08-08')])
    await mount()
    expect(lines()).toEqual([])

    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000)
    })

    expect(lines()).toEqual(['1 due today'])
  })
})
