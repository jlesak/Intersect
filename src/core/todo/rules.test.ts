import { describe, expect, test } from 'vitest'
import type { TodoRecurrence, TodoTask } from '@common/domain'
import { matchesQuery, nextOccurrence, validDay } from './rules'

const fixed = (anchorDay: string, unit: TodoRecurrence['unit']): TodoRecurrence => ({
  mode: 'fixed', unit, interval: 1, anchorDay
})

describe('TODO calendar rules', () => {
  test('validates actual calendar dates', () => {
    expect(validDay('2028-02-29')).toBe(true)
    expect(validDay('2027-02-29')).toBe(false)
  })
  test('fixed month and leap schedules return to the original anchor', () => {
    expect(nextOccurrence(fixed('2026-01-31', 'month'), '2026-01-31', '2026-01-31'))
      .toBe('2026-02-28')
    expect(nextOccurrence(fixed('2026-01-31', 'month'), '2026-02-28', '2026-02-28'))
      .toBe('2026-03-31')
    expect(nextOccurrence(fixed('2024-02-29', 'year'), '2027-02-28', '2027-02-28'))
      .toBe('2028-02-29')
  })
  test('fixed skips missed slots while relative counts from completion day', () => {
    expect(nextOccurrence(fixed('2026-01-01', 'week'), '2026-01-08', '2026-02-01'))
      .toBe('2026-02-05')
    expect(nextOccurrence({ ...fixed('2026-01-01', 'week'), mode: 'after_completion' },
      '2026-01-08', '2026-02-01')).toBe('2026-02-08')
  })
  test('filter groups AND together, OR within groups; today excludes overdue', () => {
    const task: TodoTask = { id: 't', text: 'Task', description: '', dueDay: '2026-11-10',
      priority: 1, sortOrder: 0, doneAt: null, projectId: 'p', size: 'S', tagIds: ['a'] }
    expect(matchesQuery(task, { version: 1, projects: ['p', 'q'], tags: ['x', 'a'],
      priorities: [1, 2], size: { mode: 'atMost', value: 'S' }, date: 'today' },
    '2026-11-10')).toBe(true)
    expect(matchesQuery(task, { version: 1, date: 'today' }, '2026-11-11')).toBe(false)
    expect(matchesQuery(task, { version: 1, date: 'todayView' }, '2026-11-11')).toBe(true)
    expect(matchesQuery({ ...task, dueDay: null }, { version: 1, date: 'todayView' },
      '2026-11-11')).toBe(false)
  })
})
