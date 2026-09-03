import { describe, expect, test } from 'vitest'
import { relativeAge } from './relativeAge'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = 1_780_000_000_000

describe('relativeAge', () => {
  test.each([
    [0, 'just now'],
    [59 * SECOND, 'just now'],
    [MINUTE, '1m ago'],
    [45 * MINUTE, '45m ago'],
    [HOUR, '1h ago'],
    [2 * HOUR, '2h ago'],
    [DAY, '1d ago'],
    [12 * DAY, '12d ago'],
    [29 * DAY, '29d ago'],
    [30 * DAY, '1mo ago'],
    [70 * DAY, '2mo ago']
  ])('%i ms old -> %s', (age, expected) => {
    expect(relativeAge(NOW - age, NOW)).toBe(expected)
  })

  test('a timestamp from the future reads as now rather than as a negative age', () => {
    expect(relativeAge(NOW + HOUR, NOW)).toBe('just now')
  })
})
