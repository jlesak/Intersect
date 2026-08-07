/**
 * Quick capture: writing something down without leaving whatever you were doing. A slice claims a
 * typed prefix (`todo:`, `time:`) and the command palette turns anything typed after it into that
 * slice's action, so a task noted mid-terminal costs one keystroke sequence rather than a trip
 * through the sidebar.
 *
 * The palette owns none of this vocabulary. It asks the registry what a query means and renders
 * the answer, which is what keeps three unrelated slices out of the palette's imports.
 */
export interface Capture {
  /** The literal prefix that selects this capture, colon included - e.g. `todo:`. */
  prefix: string
  /** What the capture does, shown while the user has typed the prefix but nothing usable after it. */
  hint: string
  /**
   * What running the capture on this text would do, phrased for a human to check before pressing
   * Enter, or null when the text does not yet say enough to act on.
   */
  preview(rest: string): string | null
  /** Perform the capture. Reporting its own failure is the capture's job. */
  run(rest: string): void | Promise<void>
}

const captures: Capture[] = []

/** Register a capture prefix. Throws if the prefix is already claimed. */
export function registerCapture(capture: Capture): void {
  if (captures.some((known) => known.prefix === capture.prefix)) {
    throw new Error(`Capture prefix "${capture.prefix}" is already registered`)
  }
  captures.push(capture)
}

/** Every registered capture, in registration order. */
export function getCaptures(): Capture[] {
  return [...captures]
}

/**
 * The capture a query has invoked and the text it should act on, or null when the query is not a
 * capture at all. Matching is case-insensitive on the prefix so `TODO:` works like `todo:`.
 *
 * The longest matching prefix wins, so one prefix being a prefix of another cannot make the more
 * specific capture unreachable - and which of the two happened to register first cannot decide
 * what the user's typing means.
 */
export function matchCapture(query: string): { capture: Capture; rest: string } | null {
  const lower = query.toLowerCase()
  let best: Capture | undefined
  for (const capture of captures) {
    if (!lower.startsWith(capture.prefix.toLowerCase())) continue
    if (best === undefined || capture.prefix.length > best.prefix.length) best = capture
  }
  return best === undefined ? null : { capture: best, rest: query.slice(best.prefix.length).trim() }
}

/** Test-only: clear the module-level registry between tests. */
export function __resetCaptureRegistryForTests(): void {
  captures.length = 0
}
