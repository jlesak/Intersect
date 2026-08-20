/**
 * The small amount of state that has to outlive a renderer the app cannot keep alive.
 *
 * A crash caused by persisted state repeats on every boot, and the window-scope fallback can only
 * offer a way out of that if it knows the boot before this one already failed. That knowledge has
 * to survive both a reload and a relaunch, which leaves `localStorage`: it is the one store this
 * renderer has that outlives the process, it is synchronous (so boot can consult it before the
 * first render), and it needs no IPC - which matters, because the IPC layer is one of the things
 * that may be broken when all this is read.
 *
 * Every access is wrapped on its own and every failure degrades to "nothing was recorded". A throw
 * out of here would land inside the crash fallback's own render or inside `componentDidCatch`, and
 * would take away the very last surface the user has. The bytes live in the app's own profile
 * directory, so the manual wipe the fallback points at clears these keys along with everything
 * else, which is the coupling we want.
 */

/** Marks that a window-scope crash has happened with no successful render after it. */
const UNRECOVERED_CRASH_KEY = 'intersect.recovery.unrecoveredCrash'

/** One-shot request for the next boot to skip restoring session and workspace state. */
const SAFE_MODE_KEY = 'intersect.recovery.safeModeRequest'

/** One-shot note that the boot now starting follows a view-state reset the user confirmed. */
const VIEW_RESET_KEY = 'intersect.recovery.viewStateReset'

/**
 * How long the tree has to stay mounted before the crash marker is cleared. Clearing on mount
 * alone would be too weak: a tree that renders and then throws two seconds later on the same
 * persisted value would clear the marker on every boot and never escalate. The window is short
 * because a machine slow enough to miss it would then read every later crash as a repeat.
 */
export const CRASH_SETTLE_MS = 4000

/** What the marker records: when the last unrecovered crash happened. */
export interface UnrecoveredCrash {
  at: number
}

function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeKey(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // A profile whose storage cannot be written loses the escalation and keeps the plain
    // fallback. That is a worse experience than intended and still a working one.
  }
}

function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Nothing to do: the marker staying behind costs an escalation the user can ignore.
  }
}

/**
 * The recorded crash, or null when there is none and for anything that does not parse as one.
 * A malformed value is treated as absent, so a hand-edited or half-written key never escalates
 * on evidence that does not exist.
 */
export function readUnrecoveredCrash(): UnrecoveredCrash | null {
  const raw = readKey(UNRECOVERED_CRASH_KEY)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const at = (parsed as { at?: unknown }).at
    return typeof at === 'number' && Number.isFinite(at) ? { at } : null
  } catch {
    return null
  }
}

/**
 * Record that the window went down. Only the window scope may call this: a contained region crash
 * means the window did render, so reloading it is still a reasonable thing to offer.
 */
export function markUnrecoveredCrash(at: number = Date.now()): void {
  writeKey(UNRECOVERED_CRASH_KEY, JSON.stringify({ at }))
}

/** Withdraw the marker, which only a tree that stayed alive has earned. */
export function clearUnrecoveredCrash(): void {
  removeKey(UNRECOVERED_CRASH_KEY)
}

/** Ask the next boot to start without restoring session or workspace state. */
export function requestSafeMode(): void {
  writeKey(SAFE_MODE_KEY, '1')
}

/**
 * Whether this boot was asked to run in safe mode, consuming the request as it reads it. Safe
 * mode applies once and never sticks: the flag survives a relaunch, so a request left in place
 * would strand a user in a deliberately crippled app with no memory of having asked for it.
 * Consuming it also means a crash inside safe mode cannot loop, because the boot after it is an
 * ordinary one.
 */
export function consumeSafeModeRequest(): boolean {
  const requested = readKey(SAFE_MODE_KEY) !== null
  if (requested) removeKey(SAFE_MODE_KEY)
  return requested
}

/** Note, for the boot that follows, that the user just reset their view state. */
export function noteViewStateReset(): void {
  writeKey(VIEW_RESET_KEY, '1')
}

/**
 * Whether this boot follows a confirmed reset, consuming the note. It is what lets the user tell
 * a reset that worked apart from a boot that happened to come up this time.
 */
export function consumeViewStateReset(): boolean {
  const reset = readKey(VIEW_RESET_KEY) !== null
  if (reset) removeKey(VIEW_RESET_KEY)
  return reset
}

/**
 * Throw the document away and boot again. Every escape ends here, so the one moment the app stops
 * reading its own memory and re-reads what is on disk has a single name.
 */
export function reloadWindow(): void {
  location.reload()
}
