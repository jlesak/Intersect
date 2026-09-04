/**
 * The environment an E2E run hands to Electron.
 *
 * Playwright's `env` replaces the child's environment outright, so the harness spreads the
 * developer's own `process.env` into it to keep PATH, HOME and the rest. That also inherits
 * variables the shell exported for entirely different reasons, and one of them breaks the launch
 * before a single assertion runs.
 *
 * Kept free of Playwright so it can be unit tested under Vitest, the same reason the freshness
 * guard and the app register are.
 */

/**
 * Variables that must never reach the Electron under test, whatever the shell exported.
 *
 * `ELECTRON_RUN_AS_NODE=1` is exported by the VSCode extension host (so any run started from an
 * editor terminal inherits it) and tells Electron to start as plain Node. Node then rejects the
 * switches Playwright adds to talk to the app - `bad option: --remote-debugging-port=0` - and
 * every spec fails identically at launch. That reads exactly like a broken build or a stale
 * bundle, which is the expensive part: the suite blames the code for a variable it inherited.
 */
export const STRIPPED_LAUNCH_VARS = ['ELECTRON_RUN_AS_NODE'] as const

/** An environment as the shell hands it over: a value may be absent. */
export type LaunchEnv = Record<string, string | undefined>

/**
 * Builds the launch environment: the caller's own environment, then the E2E overrides, with the
 * variables that break Electron removed last so nothing can reintroduce them.
 */
export function launchEnv(
  overrides: LaunchEnv = {},
  base: LaunchEnv = process.env
): Record<string, string> {
  const env: LaunchEnv = { ...base, ...overrides }
  for (const name of STRIPPED_LAUNCH_VARS) delete env[name]
  // Playwright's `env` takes strings only, and a variable the shell left unset arrives as
  // undefined, so those are dropped rather than passed through as the string "undefined".
  const cleaned: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) cleaned[key] = value
  }
  return cleaned
}
