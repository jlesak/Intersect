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
 * Whether the main window goes on screen or stays hidden for an automated driver.
 *
 * An E2E run launches the app well over a hundred times, and every launch that shows a window also
 * activates the app - macOS brings it to the front and hands it the keyboard, so the suite makes the
 * machine unusable for as long as it runs. Playwright drives the window over the debugging protocol
 * and needs none of that, so the harness asks for a hidden window and the app never shows one.
 *
 * Only the exact value counts: the variable is an instruction from a test driver, and a person
 * launching the app with anything else in the environment must still get a window.
 */
export function windowPresentation(env: Record<string, string | undefined>): 'shown' | 'hidden' {
  return env.INTERSECT_HIDDEN_WINDOW === '1' ? 'hidden' : 'shown'
}

/**
 * Whether a renderer input event is strong enough evidence that a person is at the machine.
 *
 * A key or button going down takes a hand. Cursor motion and the enter and leave events that come
 * with it arrive whenever the window under the pointer changes, which is something a shutdown
 * produces by itself as the windows of other apps disappear, so presence is read from presses only.
 */
export function isUserPresenceInput(type: string): boolean {
  return type === 'keyDown' || type === 'rawKeyDown' || type === 'char' || type === 'mouseDown'
}

/** A power-off signal, held for as long as it still describes what is happening. */
export interface UnattendedShutdown {
  /** The system signalled a power-off, so the quit it delivers should skip the confirmation. */
  arm(): void
  /** Withdraw the claim on evidence of a person, and report whether one was standing. */
  disarm(): boolean
  /** Whether a signalled power-off is still the best account of the quit about to happen. */
  isUnattended(): boolean
}

/**
 * The claim that a quit has nobody in front of it, kept alive only while it is provable.
 *
 * The system's power-off signal raises the claim, and it holds for the quit that a logout, restart
 * or shut down delivers next. It expires the moment a person turns out to be at the machine, which
 * is what an abandoned power-off looks like from inside the app: macOS broadcasts the signal to
 * every running app before it asks any of them to quit, one app refusing aborts the whole sequence,
 * and every app that was never asked keeps running with the claim already raised. The abort has no
 * counter-notification, so a claim left standing would skip the suspend confirmation on every quit
 * for the rest of the app's life.
 *
 * `disarm` is therefore wired to acts only a person performs: a Dock activation, and a key or
 * button press inside the window. Window focus is deliberately excluded, because macOS promotes a
 * new frontmost app as each app terminates, so the shutdown sequence raises focus by itself and
 * reading it as evidence would put an unanswerable confirmation back in front of a real logout.
 */
export function createUnattendedShutdown(): UnattendedShutdown {
  let unattended = false
  return {
    arm(): void {
      unattended = true
    },
    disarm(): boolean {
      if (!unattended) return false
      unattended = false
      return true
    },
    isUnattended: (): boolean => unattended
  }
}

/**
 * Whether a quit must put the suspend confirmation in front of a person first.
 *
 * The confirmation exists to guard live Claude sessions from a teardown the user did not intend, so
 * it is shown whenever such sessions exist and somebody is present to answer it. An unattended
 * shutdown has nobody: the OS is logging out or powering off, and a dialog raised there is answered
 * by no one, which wedges the quit and takes the logout down with it. That quit proceeds straight to
 * the same teardown the confirmation guards, which is safe because the teardown marks every live
 * session `suspended` with its resume id before it kills anything and the next launch brings them
 * back. `unattended` must come from a real system signal, so that a slow answer stays an answer.
 */
export function shouldConfirmQuit(opts: { liveCount: number; unattended: boolean }): boolean {
  return opts.liveCount > 0 && !opts.unattended
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
