import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from '@common/domain'

/** How far one zoom press moves the terminal font - the same granularity the slider offers. */
export const TERMINAL_FONT_STEP = 0.5

/**
 * The size a zoom press lands on, held inside the range the Settings slider offers. Leaning on
 * the key at either end keeps the terminal readable instead of walking off to a size the slider
 * could never show or the user could never read.
 */
export function steppedFontSize(current: number, delta: number): number {
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, current + delta))
}
