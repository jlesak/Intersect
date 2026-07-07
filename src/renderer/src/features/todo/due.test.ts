import { describe, expect, test } from 'vitest'
import { formatDueDay, isOverdue } from './due'

const TODAY = '2026-07-06'

describe('isOverdue', () => {
  test('a past due day is overdue', () => {
    expect(isOverdue('2026-07-05', TODAY)).toBe(true)
    expect(isOverdue('2025-12-31', TODAY)).toBe(true)
  })

  test('due today is not overdue', () => {
    expect(isOverdue(TODAY, TODAY)).toBe(false)
  })

  test('a future due day is not overdue', () => {
    expect(isOverdue('2026-07-07', TODAY)).toBe(false)
    expect(isOverdue('2027-01-01', TODAY)).toBe(false)
  })
})

describe('formatDueDay', () => {
  test('the three relative neighbors get words', () => {
    expect(formatDueDay('2026-07-06', TODAY)).toBe('today')
    expect(formatDueDay('2026-07-07', TODAY)).toBe('tomorrow')
    expect(formatDueDay('2026-07-05', TODAY)).toBe('yesterday')
  })

  test('anything further gets short weekday plus dd.mm', () => {
    expect(formatDueDay('2026-07-03', TODAY)).toBe('Fri 03.07')
    expect(formatDueDay('2026-07-10', TODAY)).toBe('Fri 10.07')
    expect(formatDueDay('2026-08-01', TODAY)).toBe('Sat 01.08')
  })

  test('relative words work across a month boundary', () => {
    expect(formatDueDay('2026-08-01', '2026-07-31')).toBe('tomorrow')
    expect(formatDueDay('2026-06-30', '2026-07-01')).toBe('yesterday')
  })

  test('relative words work across a year boundary', () => {
    expect(formatDueDay('2027-01-01', '2026-12-31')).toBe('tomorrow')
    expect(formatDueDay('2026-12-31', '2027-01-01')).toBe('yesterday')
  })

  test('a far date in another year still formats as weekday plus dd.mm', () => {
    expect(formatDueDay('2027-01-15', TODAY)).toBe('Fri 15.01')
  })
})
