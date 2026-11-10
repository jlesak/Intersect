import { describe, expect, test } from 'vitest'
import { monthDays, shiftMonth } from './TodoCalendar'

describe('TODO calendar month grid', () => {
  test('starts on Monday, includes every day, and crosses year boundaries', () => {
    const february = monthDays('2028-02')
    expect(february).toHaveLength(30)
    expect(february.slice(0, 3)).toEqual([null, '2028-02-01', '2028-02-02'])
    expect(february.at(-1)).toBe('2028-02-29')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
  })
})
