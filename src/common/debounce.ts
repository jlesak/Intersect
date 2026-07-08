/**
 * A debounced wrapper around `fn`: repeated calls within `delayMs` collapse into a single trailing
 * invocation carrying the most recent arguments. `flush()` runs the pending call immediately (used
 * on a settle event like blur or before quit, so nothing scheduled is ever silently dropped), and
 * `cancel()` discards it.
 */
export interface Debounced<A extends unknown[]> {
  (...args: A): void
  flush(): void
  cancel(): void
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: number
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: A | null = null

  const run = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending) {
      const args = pending
      pending = null
      fn(...args)
    }
  }

  const debounced = ((...args: A) => {
    pending = args
    if (timer) clearTimeout(timer)
    timer = setTimeout(run, delayMs)
  }) as Debounced<A>

  debounced.flush = run
  debounced.cancel = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pending = null
  }

  return debounced
}
