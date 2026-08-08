import { readdirSync, statSync, type Dirent, type Stats } from 'node:fs'
import { join } from 'node:path'

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

/** A file or directory and when it last changed, with the path relative to the repository root. */
export interface FileStamp {
  path: string
  mtimeMs: number
  kind: 'file' | 'directory'
}

export type FreshnessResult =
  /** No usable build: the launched entry, or a whole build output, is not there. */
  | { state: 'missing'; path: string }
  /**
   * The working tree has moved on. `oldestBuilt` is the single oldest file in the whole build, and
   * `newestSource` the single newest thing a build reads, so the two are the tightest pair the
   * comparison can be stated over.
   */
  | { state: 'stale'; newestSource: FileStamp; oldestBuilt: FileStamp }
  /** The filesystem would not answer, so neither can the guard. */
  | { state: 'unknown'; path: string; reason: string }
  | { state: 'fresh' }

export type GuardAction =
  | { kind: 'proceed' }
  | { kind: 'warn'; message: string }
  | { kind: 'fail'; message: string }

/** The built main entry Playwright launches, relative to the repository root. */
export const APP_ENTRY_RELATIVE_PATH = join('out', 'main', 'index.js')

/**
 * The three outputs a full build produces. Each is walked separately only to notice one that was
 * never built at all; the age of the build is the oldest file across all three together.
 *
 * Development mode builds main and preload but serves the renderer from memory, so an afternoon of
 * `npm run dev` leaves `out/main` newer than every source file while `out/renderer` still holds
 * pre-edit markup - which the launched entry loads from disk. Any rule that lets a newer file speak
 * for its neighbours reopens that hole: at the top it was the newest file anywhere under `out/`,
 * and one directory down it takes a single `.DS_Store` from a Finder visit to vouch for a whole
 * unrebuilt renderer. Nothing older than the build can survive in `out/` to be found - electron-vite
 * empties each output directory before writing it - so the oldest file present is the build's age.
 */
const BUILT_SUBTREES = [join('out', 'main'), join('out', 'preload'), join('out', 'renderer')]

/** The source tree a build reads. */
const WATCHED_SOURCE_TREE = 'src'

/**
 * Repository-root files a build reads. The lockfile stands in for `node_modules`, which is far too
 * large to walk and changes only when the lockfile does. The compiler configs belong here because
 * they steer what esbuild emits, not merely what type-checks. The build config is matched on its
 * whole name so that the scratch copy Vite leaves behind after a crash,
 * `electron.vite.config.ts.timestamp-<ms>-<rand>.mjs`, is not mistaken for the config itself and
 * named in a refusal nobody can act on.
 *
 * Known gap: deleting one of these files reads as fresh, because only the repository root directory
 * would record it and stamping the root would put `out/`, `test-results/` and every other artefact
 * directory in the way of a verdict.
 */
const WATCHED_ROOT_FILES = [
  /^electron\.vite\.config\.(ts|mts|cts|js|mjs|cjs)$/,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^tsconfig.*\.json$/,
  /^\.env(\.[^.]+)?(\.local)?$/
]

/**
 * The environment files Vite loads are `.env`, `.env.local`, `.env.[mode]` and
 * `.env.[mode].local`. A checked-in template is none of those, whatever it is named after, and
 * direnv's `.envrc` is not an environment file at all.
 */
const ENV_TEMPLATE = /^\.env\.(example|sample|template)$/

/**
 * Test files under `src/` are not build inputs: the bundler follows what the entries import, and
 * nothing imports a test. Refusing to run E2E because a unit test was edited is the kind of
 * pointless refusal that teaches people to reach for the bypass by reflex.
 *
 * The match is on the name alone, with no check of who imports what, so any source file carrying
 * `.test.` or `.spec.` in its name is invisible to the guard whatever it actually contains. No such
 * file exists today. Note also that only editing one in place goes unnoticed: adding, deleting or
 * renaming a test still registers on its parent directory, which is the same signal that catches a
 * deleted production file and is worth more than the occasional needless rebuild.
 */
const TEST_FILE = /\.(test|spec)\./
const TEST_DIRECTORY = '__tests__'

/** The built main entry inside a given checkout. */
export function appEntry(repoRoot: string): string {
  return join(repoRoot, APP_ENTRY_RELATIVE_PATH)
}

/**
 * Compare the working tree against the build it is supposed to have produced.
 *
 * Every file in the build has to be newer than every watched source input, and a tie counts against
 * the build: one needless rebuild is cheaper than one run that lies. The comparison is deliberately
 * stated at that strength, with no file speaking for its neighbours, because both earlier versions
 * of it were defeated by exactly that - one newer file standing in for a subtree that had not been
 * rebuilt.
 *
 * Directory times count on the source side, because deleting or renaming a file leaves no other
 * trace - and that is precisely the `git stash` and revert workflow this guard exists to protect.
 * They deliberately do not count on the built side, where a stray `.DS_Store` would bump a
 * directory and manufacture the very false freshness being closed here.
 *
 * An interrupted build is not covered: it can leave a partial `out/renderer` whose files are all
 * newer than source, which reads fresh. That surfaces as a loud failure to load rather than as a
 * silent green, so it is left to announce itself.
 */
export function checkBundleFreshness(repoRoot: string): FreshnessResult {
  try {
    return formVerdict(repoRoot)
  } catch (failure) {
    if (failure instanceof WalkFailure) {
      return { state: 'unknown', path: failure.path, reason: failure.reason }
    }
    throw failure
  }
}

/**
 * What the suite should do about the verdict, given the raw opt-out value.
 *
 * The opt-out is honoured only for the exact string `1`, so a half-remembered `true` fails safe
 * into the guard rather than out of it, and it downgrades exactly one verdict: a build known to be
 * stale, which somebody may legitimately want to run archaeology against. A build that is missing
 * or one the guard could not judge at all are both refused outright - in the first case there is
 * nothing to test, and in the second a path the guard cannot read is a path the bundler cannot read
 * either, so whatever is in `out/` was not built from it.
 */
export function resolveGuardAction(
  result: FreshnessResult,
  allowStaleEnvValue: string | undefined
): GuardAction {
  if (result.state === 'fresh') return { kind: 'proceed' }
  const bypassed = allowStaleEnvValue === '1'

  if (result.state === 'missing') {
    return {
      kind: 'fail',
      message:
        `The build in out/ is incomplete: ${result.path} is missing. ` +
        'Run `npm run build` and try again, or run `npm run e2e`, which builds first.'
    }
  }

  if (result.state === 'unknown') {
    return {
      kind: 'fail',
      message:
        `The E2E freshness guard cannot tell whether the build is current: ${result.path} - ` +
        `${result.reason}. A path the guard cannot read is one the build could not read either, ` +
        'so fix that path and run `npm run build`.'
    }
  }

  const drift =
    `${changeText(result.newestSource)} is at least as new as the oldest file in the build, ` +
    stampText(result.oldestBuilt)
  return bypassed
    ? {
        kind: 'warn',
        message:
          `E2E_ALLOW_STALE=1: running against a stale build on purpose. ${drift}, ` +
          'so every result below describes the last build, not the working tree.'
      }
    : {
        kind: 'fail',
        message:
          `The build is older than the working tree, so this run would report on code you are not ` +
          `looking at. ${drift}. Run \`npm run build\` and try again, or run \`npm run e2e\`, ` +
          'which builds first. To test the stale build deliberately, set E2E_ALLOW_STALE=1.'
      }
}

function formVerdict(repoRoot: string): FreshnessResult {
  if (!statOf(repoRoot, APP_ENTRY_RELATIVE_PATH)?.isFile()) {
    return { state: 'missing', path: APP_ENTRY_RELATIVE_PATH }
  }

  const built: FileStamp[] = []
  for (const subtree of BUILT_SUBTREES) {
    const oldest = stampUnder(repoRoot, subtree, 'built')
    if (!oldest) return { state: 'missing', path: subtree }
    built.push(oldest)
  }
  const oldestBuilt = built.reduce((a, b) => (b.mtimeMs < a.mtimeMs ? b : a))

  const newestSource = watchedSources(repoRoot)
    .map((input) => stampUnder(repoRoot, input, 'source'))
    .reduce(newerOf, undefined)
  if (!newestSource) {
    return { state: 'unknown', path: WATCHED_SOURCE_TREE, reason: 'no watched source input exists' }
  }

  if (newestSource.mtimeMs < oldestBuilt.mtimeMs) return { state: 'fresh' }
  return { state: 'stale', newestSource, oldestBuilt }
}

function watchedSources(repoRoot: string): string[] {
  const rootFiles = readEntries(repoRoot, '.')
    .filter((entry) => entry.isFile() && isWatchedRootFile(entry.name))
    .map((entry) => entry.name)
    .sort()
  return [WATCHED_SOURCE_TREE, ...rootFiles]
}

function isWatchedRootFile(name: string): boolean {
  if (ENV_TEMPLATE.test(name)) return false
  return WATCHED_ROOT_FILES.some((pattern) => pattern.test(name))
}

/**
 * The newest entry at or below a source input, or the oldest file at or below a build output -
 * whichever end of the range the caller has to beat. A path that does not exist contributes
 * nothing: an absent build output is already the caller's `missing` verdict, and an absent watched
 * input is a checkout shape this guard has no opinion about.
 */
function stampUnder(
  repoRoot: string,
  relativePath: string,
  mode: 'source' | 'built'
): FileStamp | undefined {
  const stats = statOf(repoRoot, relativePath)
  if (!stats) return undefined
  if (stats.isFile()) {
    return { path: relativePath, mtimeMs: stats.mtimeMs, kind: 'file' }
  }
  if (!stats.isDirectory()) return undefined

  const keep = mode === 'source' ? newerOf : olderOf
  let found: FileStamp | undefined =
    mode === 'source'
      ? { path: relativePath, mtimeMs: stats.mtimeMs, kind: 'directory' }
      : undefined
  for (const entry of readEntries(repoRoot, relativePath)) {
    if (mode === 'source' && isTestArtefact(entry)) continue
    found = keep(found, stampUnder(repoRoot, join(relativePath, entry.name), mode))
  }
  return found
}

function isTestArtefact(entry: Dirent): boolean {
  return entry.isDirectory() ? entry.name === TEST_DIRECTORY : TEST_FILE.test(entry.name)
}

function newerOf(a: FileStamp | undefined, b: FileStamp | undefined): FileStamp | undefined {
  if (!a) return b
  if (!b) return a
  return b.mtimeMs > a.mtimeMs ? b : a
}

function olderOf(a: FileStamp | undefined, b: FileStamp | undefined): FileStamp | undefined {
  if (!a) return b
  if (!b) return a
  return b.mtimeMs < a.mtimeMs ? b : a
}

function stampText(stamp: FileStamp): string {
  return `${stamp.path} (${new Date(stamp.mtimeMs).toISOString()})`
}

/**
 * How a source input came to be that new. A directory only moves when something inside it appears
 * or disappears, and reporting one as though a developer had edited it reads as a malfunction -
 * which is how reaching for the bypass becomes reflex.
 */
function changeText(stamp: FileStamp): string {
  return stamp.kind === 'directory'
    ? `A file was added, removed or renamed in ${stampText(stamp)}, which`
    : stampText(stamp)
}

/**
 * A path the guard needed to read and could not. Symlink loops and unreadable directories would
 * otherwise surface as a bare filesystem error out of Playwright's global setup, with nothing to
 * say the guard was even involved.
 */
class WalkFailure extends Error {
  path: string
  reason: string

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`)
    this.path = path
    this.reason = reason
  }
}

function statOf(repoRoot: string, relativePath: string): Stats | undefined {
  try {
    return statSync(join(repoRoot, relativePath), { throwIfNoEntry: false })
  } catch (error) {
    throw new WalkFailure(relativePath, describeError(error))
  }
}

function readEntries(repoRoot: string, relativePath: string): Dirent[] {
  try {
    return readdirSync(join(repoRoot, relativePath), { withFileTypes: true })
  } catch (error) {
    throw new WalkFailure(relativePath, describeError(error))
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
