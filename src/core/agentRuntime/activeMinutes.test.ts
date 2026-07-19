import { describe, expect, test } from 'vitest'
import { activeMinutesByDate, IDLE_CAP_MS } from './activeMinutes'

const MIN = 60 * 1000

/**
 * Local-time epoch helper so day bucketing is timezone-independent: the pings are built from
 * local Date fields, exactly the fields `dayKeyOf` reads back, so the assertions hold in any TZ.
 */
function at(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
}

describe('activeMinutesByDate', () => {
  test('empty or single ping has no measurable duration', () => {
    expect(activeMinutesByDate([], IDLE_CAP_MS).size).toBe(0)
    expect(activeMinutesByDate([at(2026, 7, 3, 10, 0)], IDLE_CAP_MS).size).toBe(0)
  })

  test('sums sub-cap gaps within a day', () => {
    const t = at(2026, 7, 3, 10, 0)
    const pings = [t, t + 3 * MIN, t + 8 * MIN] // 3 + 5 = 8 min
    expect(activeMinutesByDate(pings, IDLE_CAP_MS).get('2026-07-03')).toBe(8)
  })

  test('caps a long idle gap at the idle cap', () => {
    const t = at(2026, 7, 3, 10, 0)
    expect(activeMinutesByDate([t, t + 60 * MIN], IDLE_CAP_MS).get('2026-07-03')).toBe(10)
  })

  test('splits across midnight, crediting each gap to the earlier ping day', () => {
    const late = at(2026, 7, 3, 23, 58)
    const early = at(2026, 7, 4, 0, 3) // 5-min gap, spans midnight
    const next = early + 4 * MIN
    const m = activeMinutesByDate([late, early, next], IDLE_CAP_MS)
    expect(m.get('2026-07-03')).toBe(5)
    expect(m.get('2026-07-04')).toBe(4)
  })

  test('is order-independent', () => {
    const t = at(2026, 7, 3, 10, 0)
    const m = activeMinutesByDate([t + 8 * MIN, t, t + 3 * MIN], IDLE_CAP_MS)
    expect(m.get('2026-07-03')).toBe(8)
  })

  test('drops a day whose activity rounds to under a minute', () => {
    const t = at(2026, 7, 3, 10, 0)
    expect(activeMinutesByDate([t, t + 20 * 1000], IDLE_CAP_MS).size).toBe(0)
  })
})
