import { describe, expect, test } from 'vitest'
import type { TimeEntry } from '@common/domain'
import {
  formatDayDate,
  formatTotal,
  formatWeekRange,
  groupByDay,
  normalizeIssueKey,
  parseDuration,
  totalMs
} from './time'

const entry = (over: Partial<TimeEntry> = {}): TimeEntry => ({
  id: 'e1',
  source: 'auto',
  day: '2026-07-06',
  description: 'work',
  issueKey: null,
  durationMs: 60_000,
  ...over
})

describe('parseDuration', () => {
  test.each([
    ['1h 30m', 90],
    ['1h30m', 90],
    ['1h30', 90],
    ['2h', 120],
    ['90m', 90],
    ['90', 90],
    ['45m', 45],
    ['1:30', 90],
    ['1:5', 65],
    ['0:45', 45],
    ['2H', 120],
    ['  1h  15m  ', 75]
  ])('parses %s as %i minutes', (input, minutes) => {
    expect(parseDuration(input)).toBe(minutes * 60_000)
  })

  test.each([['', null], ['   ', null], ['abc', null], ['h', null], ['1x', null], ['30m 1h', null], ['1:75', null], ['1.5h', null], ['-30m', null]])(
    'rejects %j',
    (input) => {
      expect(parseDuration(input as string)).toBeNull()
    }
  )

  test.each([['0'], ['0m'], ['0h'], ['0:00'], ['0h 0m']])(
    'rejects the zero duration %j - nothing was logged',
    (input) => {
      expect(parseDuration(input)).toBeNull()
    }
  )
})

describe('normalizeIssueKey', () => {
  test('trims and uppercases', () => {
    expect(normalizeIssueKey('  fid2507-611 ')).toBe('FID2507-611')
  })

  test('empty input means no issue', () => {
    expect(normalizeIssueKey('')).toBeNull()
    expect(normalizeIssueKey('   ')).toBeNull()
  })
})

describe('groupByDay and totals', () => {
  const entries = [
    entry({ id: 'a', day: '2026-07-06', durationMs: 30 * 60_000 }),
    entry({ id: 'b', day: '2026-07-06', durationMs: 15 * 60_000 }),
    entry({ id: 'c', day: '2026-07-08', durationMs: 60 * 60_000 })
  ]

  test('groups entries by day preserving order', () => {
    const byDay = groupByDay(entries)
    expect([...byDay.keys()]).toEqual(['2026-07-06', '2026-07-08'])
    expect(byDay.get('2026-07-06')!.map((e) => e.id)).toEqual(['a', 'b'])
  })

  test('totalMs sums durations', () => {
    expect(totalMs(entries)).toBe(105 * 60_000)
    expect(totalMs([])).toBe(0)
  })

  test('formatTotal shows 0m for nothing and h/m otherwise', () => {
    expect(formatTotal(0)).toBe('0m')
    expect(formatTotal(105 * 60_000)).toBe('1h 45m')
    expect(formatTotal(45 * 60_000)).toBe('45m')
  })
})

describe('date labels', () => {
  test('formatDayDate renders dd.mm', () => {
    expect(formatDayDate('2026-07-06')).toBe('06.07')
    expect(formatDayDate('2026-11-30')).toBe('30.11')
  })

  test('formatWeekRange renders the Monday-to-Friday range with the year', () => {
    expect(formatWeekRange('2026-06-29')).toBe('29.06 – 03.07.2026')
  })

  test('formatWeekRange across a year boundary uses the end year', () => {
    expect(formatWeekRange('2026-12-28')).toBe('28.12 – 01.01.2027')
  })
})
