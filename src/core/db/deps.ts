/**
 * Injected side-effect dependencies for repositories. Passing these in (rather than calling
 * Date.now()/crypto.randomUUID() inline) keeps repos deterministic under test: tests inject a
 * monotonic clock and predictable ids, production uses the real ones.
 */
export interface RepoDeps {
  now: () => number
  newId: () => string
}

/** Production defaults: wall clock + random UUID. */
export const defaultRepoDeps: RepoDeps = {
  now: () => Date.now(),
  newId: () => crypto.randomUUID()
}
