import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from '@common/domain'

/**
 * How far one zoom press moves the terminal font. Deliberately coarser than the settings slider:
 * the slider is for fine tuning and the key is for zooming, and a press that moved as little as
 * the slider does would read as a key that did nothing. It stays on the slider's own half-point
 * grid, so the two never land on sizes the other cannot express.
 */
export const TERMINAL_FONT_STEP = 1

/**
 * The size a zoom press lands on, held inside the range the Settings slider offers. Leaning on
 * the key at either end keeps the terminal readable instead of walking off to a size the slider
 * could never show or the user could never read.
 */
export function steppedFontSize(current: number, delta: number): number {
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, current + delta))
}
