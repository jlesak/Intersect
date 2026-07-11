/** Selector matching the hosts that own Escape themselves: the review terminal and the Monaco diff. */
const KEYBOARD_HOST = '.ix-pr-review__term, .xterm, .ix-pr-diff__host, .monaco-editor'

/**
 * Whether a plain Escape in the detail chrome should navigate back to the board. It must not while
 * a review is running (the terminal keeps running in the background) nor when the keystroke lands
 * inside the review terminal or the Monaco diff editor, where Escape is a common in-widget action.
 */
export function escapeShouldGoBack(reviewRunning: boolean, target: EventTarget | null): boolean {
  if (reviewRunning) return false
  const el = target instanceof Element ? target : null
  return !el?.closest(KEYBOARD_HOST)
}
