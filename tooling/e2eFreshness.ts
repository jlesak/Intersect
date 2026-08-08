import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Whether the built app the E2E suite launches still describes the code in the working tree.
 *
 * The suite runs against `out/`, never against source, so a run started without a build reports on
 * whatever was last built. That failure mode is the expensive one: it does not error or skip, it
 * passes, and it passes hardest during the deliberate sabotage checks that exist to prove the suite
 * can still tell the truth.
 *
 * Kept free of Playwright and of the harness so it can be unit tested under Vitest. The repository
 * root arrives as a parameter for the same reason: this module is loaded as ESM by Vitest, where
 * `__dirname` does not exist, while its callers run under Playwright's CommonJS transpile, where it
 * does.
 */

/** A file and when it last changed, with the path relative to the repository root. */
export interface FileStamp {
  path: string
  mtimeMs: number
}

export type FreshnessResult =
  | { state: 'missing'; entry: string }
  | { state: 'stale'; newestSource: FileStamp; newestBuilt: FileStamp }
  | { state: 'fresh' }

export type GuardAction =
  | { kind: 'proceed' }
  | { kind: 'warn'; message: string }
  | { kind: 'fail'; message: string }

/** The built main entry Playwright launches, relative to the repository root. */
export const APP_ENTRY_RELATIVE_PATH = join('out', 'main', 'index.js')

/** The built main entry inside a given checkout. */
export function appEntry(repoRoot: string): string {
  return join(repoRoot, APP_ENTRY_RELATIVE_PATH)
}

/**
 * Everything a build turns into `out/`. The lockfile stands in for `node_modules`, which is far too
 * large to walk and changes only when the lockfile does. The specs are deliberately absent: editing
 * `e2e/` cannot invalidate a build, and treating it as an input would make the guard fire during
 * exactly the workflow it is meant to leave alone.
 */
const WATCHED_SOURCES = ['src', 'package.json', 'package-lock.json']

/** The build config counts under whichever extension it is written in. */
const BUILD_CONFIG_PREFIX = 'electron.vite.config.'

const BUILD_OUTPUT = 'out'

/**
 * Compare the working tree against the build it is supposed to have produced.
 *
 * Only files carry a verdict; directory timestamps are ignored, so a source file that was deleted
 * rather than edited will not be noticed. Every other edit bumps a file of its own.
 */
export function checkBundleFreshness(repoRoot: string): FreshnessResult {
  if (!statSync(appEntry(repoRoot), { throwIfNoEntry: false })) {
    return { state: 'missing', entry: APP_ENTRY_RELATIVE_PATH }
  }

  const newestBuilt = newestFileUnder(repoRoot, BUILD_OUTPUT)
  const newestSource = [...WATCHED_SOURCES, ...buildConfigsIn(repoRoot)]
    .map((input) => newestFileUnder(repoRoot, input))
    .reduce(newerOf, undefined)
  if (!newestBuilt || !newestSource || newestSource.mtimeMs <= newestBuilt.mtimeMs) {
    return { state: 'fresh' }
  }
  return { state: 'stale', newestSource, newestBuilt }
}

/**
 * What the suite should do about the verdict, given the raw opt-out value.
 *
 * The opt-out is honoured only for the exact string `1`, so a half-remembered `true` fails safe
 * into the guard rather than out of it. A build that does not exist at all is refused whatever the
 * environment says: there is nothing to deliberately test against.
 */
export function resolveGuardAction(
  result: FreshnessResult,
  allowStaleEnvValue: string | undefined
): GuardAction {
  if (result.state === 'fresh') return { kind: 'proceed' }
  if (result.state === 'missing') {
    return {
      kind: 'fail',
      message:
        `There is no built app to test: ${result.entry} does not exist. ` +
        'Run `npm run build` and try again, or run `npm run e2e`, which builds first.'
    }
  }

  const drift =
    `${stampText(result.newestSource)} is newer than the newest build output, ` +
    stampText(result.newestBuilt)
  if (allowStaleEnvValue === '1') {
    return {
      kind: 'warn',
      message:
        `E2E_ALLOW_STALE=1: running against a stale build on purpose. ${drift}, ` +
        'so every result below describes the last build, not the working tree.'
    }
  }
  return {
    kind: 'fail',
    message:
      `The build is older than the working tree, so this run would report on code you are not ` +
      `looking at. ${drift}. Run \`npm run build\` and try again, or run \`npm run e2e\`, which ` +
      'builds first. To test the stale build deliberately, set E2E_ALLOW_STALE=1.'
  }
}

function buildConfigsIn(repoRoot: string): string[] {
  return readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(BUILD_CONFIG_PREFIX))
    .map((entry) => entry.name)
}

function stampText(stamp: FileStamp): string {
  return `${stamp.path} (${new Date(stamp.mtimeMs).toISOString()})`
}

function newerOf(a: FileStamp | undefined, b: FileStamp | undefined): FileStamp | undefined {
  if (!a) return b
  if (!b) return a
  return b.mtimeMs > a.mtimeMs ? b : a
}

/**
 * The most recently modified file at or below a path inside the repository. A path that does not
 * exist simply contributes nothing: an absent `out/` is already the caller's `missing` verdict, and
 * an absent watched input is a checkout shape this guard has no opinion about.
 */
function newestFileUnder(repoRoot: string, relativePath: string): FileStamp | undefined {
  const absolute = join(repoRoot, relativePath)
  const stats = statSync(absolute, { throwIfNoEntry: false })
  if (!stats) return undefined
  if (stats.isFile()) return { path: relative(repoRoot, absolute), mtimeMs: stats.mtimeMs }
  if (!stats.isDirectory()) return undefined

  let newest: FileStamp | undefined
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    newest = newerOf(newest, newestFileUnder(repoRoot, join(relativePath, entry.name)))
  }
  return newest
}
