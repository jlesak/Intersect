import { describe, expect, test } from 'vitest'
import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from '@common/domain'
import { steppedFontSize, TERMINAL_FONT_STEP } from './fontSize'

describe('steppedFontSize', () => {
  test('moves one step in the direction asked for', () => {
    expect(steppedFontSize(12.5, TERMINAL_FONT_STEP)).toBe(13.5)
    expect(steppedFontSize(12.5, -TERMINAL_FONT_STEP)).toBe(11.5)
  })

  test('stops at the largest size the settings slider offers', () => {
    expect(steppedFontSize(TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_STEP)).toBe(TERMINAL_FONT_SIZE_MAX)
    expect(steppedFontSize(TERMINAL_FONT_SIZE_MAX - 0.25, TERMINAL_FONT_STEP)).toBe(
      TERMINAL_FONT_SIZE_MAX
    )
  })

  test('stops at the smallest size the settings slider offers', () => {
    expect(steppedFontSize(TERMINAL_FONT_SIZE_MIN, -TERMINAL_FONT_STEP)).toBe(TERMINAL_FONT_SIZE_MIN)
    expect(steppedFontSize(TERMINAL_FONT_SIZE_MIN + 0.25, -TERMINAL_FONT_STEP)).toBe(
      TERMINAL_FONT_SIZE_MIN
    )
  })

  test('a long walk up and back lands on exactly the size it started from', () => {
    let size = 12.5
    // Short of either end, so what is being tested is the arithmetic and not the clamp.
    for (let i = 0; i < 6; i += 1) size = steppedFontSize(size, TERMINAL_FONT_STEP)
    for (let i = 0; i < 6; i += 1) size = steppedFontSize(size, -TERMINAL_FONT_STEP)
    expect(size).toBe(12.5)
  })
})
