import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { appEntry, checkBundleFreshness, resolveGuardAction } from './e2eFreshness'

/**
 * The freshness comparison decides whether an E2E run is allowed to believe itself, so every case
 * runs against a real throwaway repository tree rather than a mocked filesystem: the trap being
 * closed here is exactly a mismatch between what the code assumes about mtimes on disk and what is
 * actually there.
 *
 * Modification times are stamped explicitly instead of relying on write order. A build and an edit
 * a few milliseconds apart are indistinguishable on a coarse clock, which would make the whole
 * suite decide by luck.
 */
describe('checkBundleFreshness', () => {
  const BUILT_AT = 1_700_000_000
  const BEFORE_BUILD = BUILT_AT - 60
  const AFTER_BUILD = BUILT_AT + 60

  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'intersect-freshness-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** Create a file with the given seconds-resolution modification time. */
  const fileAt = (relativePath: string, seconds: number): void => {
    const absolute = join(root, relativePath)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, '')
    utimesSync(absolute, seconds, seconds)
  }

  /** A repository whose build is newer than every watched source input. */
  const freshRepo = (): void => {
    fileAt('src/renderer/src/App.tsx', BEFORE_BUILD)
    fileAt('src/main/index.ts', BEFORE_BUILD)
    fileAt('electron.vite.config.ts', BEFORE_BUILD)
    fileAt('package.json', BEFORE_BUILD)
    fileAt('package-lock.json', BEFORE_BUILD)
    fileAt('e2e/harness.ts', BEFORE_BUILD)
    fileAt('out/main/index.js', BUILT_AT)
    fileAt('out/renderer/index.html', BUILT_AT)
  }

  test('a repository with no out directory has nothing to test', () => {
    freshRepo()
    rmSync(join(root, 'out'), { recursive: true, force: true })

    expect(checkBundleFreshness(root)).toEqual({ state: 'missing', entry: 'out/main/index.js' })
  })

  test('an out directory without the launched entry still has nothing to test', () => {
    freshRepo()
    rmSync(join(root, 'out', 'main'), { recursive: true, force: true })

    expect(checkBundleFreshness(root).state).toBe('missing')
  })

  test('a build newer than every source input is fresh', () => {
    freshRepo()

    expect(checkBundleFreshness(root)).toEqual({ state: 'fresh' })
  })

  test('a source file touched after the build names itself', () => {
    freshRepo()
    fileAt('src/renderer/src/App.tsx', AFTER_BUILD)

    const result = checkBundleFreshness(root)
    expect(result.state).toBe('stale')
    if (result.state !== 'stale') return
    expect(result.newestSource.path).toBe('src/renderer/src/App.tsx')
    expect(result.newestSource.mtimeMs).toBe(AFTER_BUILD * 1000)
    expect(result.newestBuilt.mtimeMs).toBe(BUILT_AT * 1000)
  })

  test('a build config touched after the build is stale', () => {
    freshRepo()
    fileAt('electron.vite.config.ts', AFTER_BUILD)

    const result = checkBundleFreshness(root)
    expect(result.state).toBe('stale')
    if (result.state !== 'stale') return
    expect(result.newestSource.path).toBe('electron.vite.config.ts')
  })

  test('the build config counts under whichever extension it carries', () => {
    freshRepo()
    fileAt('electron.vite.config.mts', AFTER_BUILD)

    const result = checkBundleFreshness(root)
    expect(result.state).toBe('stale')
    if (result.state !== 'stale') return
    expect(result.newestSource.path).toBe('electron.vite.config.mts')
  })

  test('a manifest touched after the build is stale', () => {
    freshRepo()
    fileAt('package.json', AFTER_BUILD)

    const result = checkBundleFreshness(root)
    expect(result.state).toBe('stale')
    if (result.state !== 'stale') return
    expect(result.newestSource.path).toBe('package.json')
  })

  test('a lockfile touched after the build is stale, standing in for node_modules', () => {
    freshRepo()
    fileAt('package-lock.json', AFTER_BUILD)

    const result = checkBundleFreshness(root)
    expect(result.state).toBe('stale')
    if (result.state !== 'stale') return
    expect(result.newestSource.path).toBe('package-lock.json')
  })

  test('editing only the specs leaves the build fresh', () => {
    freshRepo()
    fileAt('e2e/harness.ts', AFTER_BUILD)
    fileAt('e2e/prInbox.spec.ts', AFTER_BUILD)

    expect(checkBundleFreshness(root)).toEqual({ state: 'fresh' })
  })

  test('the newest build output counts wherever it sits in the tree', () => {
    freshRepo()
    fileAt('src/renderer/src/App.tsx', AFTER_BUILD)
    fileAt('out/renderer/assets/chunks/deep/worker.js', AFTER_BUILD + 60)

    const result = checkBundleFreshness(root)
    expect(result).toEqual({ state: 'fresh' })
  })

  test('the entry resolves under the repository root it is asked about', () => {
    expect(appEntry(root)).toBe(join(root, 'out', 'main', 'index.js'))
  })
})

/**
 * What the guard says, and to whom. The wording is asserted here rather than in the Playwright hook
 * because a message that fails to name the fix costs a developer the same half hour the missing
 * guard used to.
 */
describe('resolveGuardAction', () => {
  const stale = {
    state: 'stale',
    newestSource: { path: 'src/renderer/src/App.tsx', mtimeMs: 1_700_000_060_000 },
    newestBuilt: { path: 'out/renderer/index.html', mtimeMs: 1_700_000_000_000 }
  } as const
  const missing = { state: 'missing', entry: 'out/main/index.js' } as const
  const fresh = { state: 'fresh' } as const

  test('a fresh build starts the suite without a word', () => {
    expect(resolveGuardAction(fresh, undefined)).toEqual({ kind: 'proceed' })
    expect(resolveGuardAction(fresh, '1')).toEqual({ kind: 'proceed' })
  })

  test('a stale build is refused, naming the offender and both ways to build', () => {
    const action = resolveGuardAction(stale, undefined)

    expect(action.kind).toBe('fail')
    if (action.kind === 'proceed') return
    expect(action.message).toContain('src/renderer/src/App.tsx')
    expect(action.message).toContain('out/renderer/index.html')
    expect(action.message).toContain('npm run build')
    expect(action.message).toContain('npm run e2e')
  })

  test('a missing build is refused, naming the file and both ways to build', () => {
    const action = resolveGuardAction(missing, undefined)

    expect(action.kind).toBe('fail')
    if (action.kind === 'proceed') return
    expect(action.message).toContain('out/main/index.js')
    expect(action.message).toContain('npm run build')
    expect(action.message).toContain('npm run e2e')
  })

  test('an exact opt-in downgrades a stale build to a warning that admits how stale it is', () => {
    const action = resolveGuardAction(stale, '1')

    expect(action.kind).toBe('warn')
    if (action.kind === 'proceed') return
    expect(action.message).toContain('E2E_ALLOW_STALE')
    expect(action.message).toContain('src/renderer/src/App.tsx')
    expect(action.message).toContain('out/renderer/index.html')
  })

  test.each([['true'], ['0'], [''], ['yes'], ['1 ']])(
    'the opt-in value %o is not the opt-in and the run is still refused',
    (value) => {
      expect(resolveGuardAction(stale, value).kind).toBe('fail')
    }
  )

  test('the opt-in cannot conjure a build that was never made', () => {
    expect(resolveGuardAction(missing, '1').kind).toBe('fail')
  })
})
