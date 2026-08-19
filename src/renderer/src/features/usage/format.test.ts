import { describe, expect, test } from 'vitest'
import { formatUsagePercent } from './format'

describe('formatUsagePercent', () => {
  test('rounds usage to a whole percentage', () => {
    expect(formatUsagePercent(7.000000000000001)).toBe('7%')
    expect(formatUsagePercent(42.4)).toBe('42%')
    expect(formatUsagePercent(94.6)).toBe('95%')
  })
})
