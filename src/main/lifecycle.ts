import type { CoreStatus } from '@common/ipc'

/**
 * Dock-only macOS lifecycle decisions, extracted pure so the app-event glue in index.ts
 * stays a one-liner per event and the behavior is testable without Electron.
 */

/**
 * Whether closing the last window should quit the app. On macOS the app lives in the Dock:
 * the core process and its PTYs keep running and a Dock click reopens a window - so only an
 * already-quitting app (Cmd+Q raced the close) proceeds. Everywhere else, closing the last
 * window means quit.
 */
export function shouldQuitOnWindowAllClosed(opts: { platform: string; quitting: boolean }): boolean {
  return opts.quitting || opts.platform !== 'darwin'
}

/**
 * What a Dock activation should do: focus the existing window, create exactly one new one,
 * or nothing while the app is shutting down. `hasLiveWindow` must already account for a
 * window under construction - window creation is synchronous, so holding the reference from
 * creation time is the double-activation guard.
 */
export function activateAction(opts: {
  hasLiveWindow: boolean
  quitting: boolean
}): 'focus' | 'create' | 'none' {
  if (opts.quitting) return 'none'
  return opts.hasLiveWindow ? 'focus' : 'create'
}

/**
 * Whether a confirmed quit should proceed to teardown or leave the app alive, extracted pure so
 * the Electron dialog glue in index.ts stays testable without a window. With no live Claude
 * sessions there is nothing to confirm - the quit proceeds. Otherwise the modal decides: response
 * 0 (Suspend & Quit) proceeds, response 1 (Cancel) or a dismissed dialog leaves every session and
 * process untouched so a later quit re-prompts. `response` is only meaningful when a dialog was
 * shown (liveCount > 0).
 */
export function quitDecision(liveCount: number, response: number | null): 'quit' | 'stay' {
  if (liveCount === 0) return 'quit'
  return response === 0 ? 'quit' : 'stay'
}

/**
 * Whether a core status transition must zero the Dock badge. The badge is sourced solely
 * from the core's canonical attention count, and a fresh core only pushes on changes - so a
 * count left over from a dead core would silently survive a restart unless main clears it
 * the moment the core stops being ready.
 */
export function shouldZeroDockBadge(status: CoreStatus): boolean {
  return status.state === 'restarting' || status.state === 'failed'
}
