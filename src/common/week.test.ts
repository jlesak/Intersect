import { describe, expect, test } from 'vitest'
import { addDays, dateOfDayKey, dayKeyOf, weekdayKeys, weekStartOf } from './week'

/** Epoch ms for a local date-time, so expectations hold in any timezone the suite runs in. */
const local = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime()

describe('dayKeyOf', () => {
  test('formats the local calendar day with zero padding', () => {
    expect(dayKeyOf(local(2026, 7, 6))).toBe('2026-07-06')
    expect(dayKeyOf(local(2026, 11, 30))).toBe('2026-11-30')
  })

  test('one millisecond before local midnight still belongs to the earlier day', () => {
    expect(dayKeyOf(new Date(2026, 6, 6, 23, 59, 59, 999).getTime())).toBe('2026-07-06')
    expect(dayKeyOf(new Date(2026, 6, 7, 0, 0, 0, 0).getTime())).toBe('2026-07-07')
  })
})

describe('dateOfDayKey', () => {
  test('round-trips through dayKeyOf', () => {
    expect(dayKeyOf(dateOfDayKey('2026-02-28').getTime())).toBe('2026-02-28')
  })
})

describe('addDays', () => {
  test('moves forward and backward within a month', () => {
    expect(addDays('2026-07-06', 4)).toBe('2026-07-10')
    expect(addDays('2026-07-06', -1)).toBe('2026-07-05')
  })

  test('crosses month and year boundaries', () => {
    expect(addDays('2026-06-29', 7)).toBe('2026-07-06')
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04')
    expect(addDays('2027-01-04', -7)).toBe('2026-12-28')
  })

  test('handles a leap-year February', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29')
  })

  test('crosses the spring DST transition without gaining or losing a day', () => {
    // In DST timezones a day near the transition is 23 or 25 hours long; local Date
    // arithmetic must still land exactly seven calendar days later (2026-03-29 is the
    // EU spring-forward Sunday; the assertion is timezone-independent).
    expect(addDays('2026-03-25', 7)).toBe('2026-04-01')
    expect(addDays('2026-10-21', 7)).toBe('2026-10-28')
  })
})

describe('weekStartOf', () => {
  test('a Monday is its own week start', () => {
    expect(weekStartOf(local(2026, 7, 6))).toBe('2026-07-06')
  })

  test('midweek and Sunday map back to the preceding Monday', () => {
    expect(weekStartOf(local(2026, 7, 8))).toBe('2026-07-06')
    expect(weekStartOf(local(2026, 7, 12))).toBe('2026-07-06')
  })

  test('a week spanning a month boundary starts in the earlier month', () => {
    // 2026-07-01 is a Wednesday; its week starts Monday 2026-06-29.
    expect(weekStartOf(local(2026, 7, 1))).toBe('2026-06-29')
  })

  test('a week spanning a year boundary starts in the earlier year', () => {
    // 2027-01-01 is a Friday; its week starts Monday 2026-12-28.
    expect(weekStartOf(local(2027, 1, 1))).toBe('2026-12-28')
  })

  test('a timestamp just after local midnight buckets into that day\'s week', () => {
    expect(weekStartOf(new Date(2026, 6, 6, 0, 0, 1).getTime())).toBe('2026-07-06')
  })
})

describe('weekdayKeys', () => {
  test('returns Monday through Friday of the week', () => {
    expect(weekdayKeys('2026-07-06')).toEqual([
      '2026-07-06',
      '2026-07-07',
      '2026-07-08',
      '2026-07-09',
      '2026-07-10'
    ])
  })

  test('spans a month boundary', () => {
    expect(weekdayKeys('2026-06-29')).toEqual([
      '2026-06-29',
      '2026-06-30',
      '2026-07-01',
      '2026-07-02',
      '2026-07-03'
    ])
  })
})
