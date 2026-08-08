import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { appEntry, checkBundleFreshness, resolveGuardAction } from './e2eFreshness'

/**
 * The freshness comparison decides whether an E2E run is allowed to believe itself, so every case
 * runs against a real throwaway repository tree rather than a mocked filesystem: the trap being
 * closed here is exactly a mismatch between what the code assumes about the filesystem and what is
 * actually on it.
 *
 * Modification times are stamped explicitly instead of relying on write order. A build and an edit
 * a few milliseconds apart are indistinguishable on a coarse clock, which would make the whole
 * suite decide by luck. Directories are stamped too, because creating a fixture file bumps its
 * parent to the wall clock and the guard reads directory times on the source side.
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

  /** Create or overwrite a file with the given seconds-resolution modification time. */
  const fileAt = (relativePath: string, seconds: number): void => {
    const absolute = join(root, relativePath)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, '')
    utimesSync(absolute, seconds, seconds)
  }

  /** Stamp every directory in the fixture, which creating files has left at the wall clock. */
  const stampDirectories = (seconds: number): void => {
    const visit = (absolute: string): void => {
      for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        if (entry.isDirectory()) visit(join(absolute, entry.name))
      }
      utimesSync(absolute, seconds, seconds)
    }
    visit(root)
  }

  /**
   * A checkout whose build is newer than every watched source input: three populated build
   * subtrees, sources and tests that predate them, and specs which are not inputs at all.
   */
  const freshRepo = (): void => {
    fileAt('src/renderer/src/App.tsx', BEFORE_BUILD)
    fileAt('src/renderer/src/App.test.tsx', BEFORE_BUILD)
    fileAt('src/renderer/src/App.spec.tsx', BEFORE_BUILD)
    fileAt('src/renderer/src/__tests__/appBehaviour.ts', BEFORE_BUILD)
    fileAt('src/main/index.ts', BEFORE_BUILD)
    fileAt('electron.vite.config.ts', BEFORE_BUILD)
    fileAt('package.json', BEFORE_BUILD)
    fileAt('package-lock.json', BEFORE_BUILD)
    fileAt('tsconfig.web.json', BEFORE_BUILD)
    fileAt('e2e/harness.ts', BEFORE_BUILD)
    fileAt('out/main/index.js', BUILT_AT)
    fileAt('out/main/chunks/core.js', BUILT_AT)
    fileAt('out/preload/index.js', BUILT_AT)
    fileAt('out/renderer/index.html', BUILT_AT)
    fileAt('out/renderer/assets/index.js', BUILT_AT)
    stampDirectories(BEFORE_BUILD)
  }

  describe('an incomplete build', () => {
    test('a checkout with no out directory has nothing to test', () => {
      freshRepo()
      rmSync(join(root, 'out'), { recursive: true, force: true })

      expect(checkBundleFreshness(root)).toEqual({ state: 'missing', path: 'out/main/index.js' })
    })

    test('an out directory without the launched entry has nothing to test', () => {
      freshRepo()
      rmSync(join(root, 'out', 'main'), { recursive: true, force: true })

      expect(checkBundleFreshness(root)).toEqual({ state: 'missing', path: 'out/main/index.js' })
    })

    test('a directory sitting where the entry belongs is not a built app', () => {
      freshRepo()
      rmSync(join(root, 'out', 'main', 'index.js'))
      mkdirSync(join(root, 'out', 'main', 'index.js'))

      expect(checkBundleFreshness(root)).toEqual({ state: 'missing', path: 'out/main/index.js' })
    })

    test('a renderer that was never built is named, though the entry is there', () => {
      freshRepo()
      rmSync(join(root, 'out', 'renderer'), { recursive: true, force: true })

      expect(checkBundleFreshness(root)).toEqual({ state: 'missing', path: 'out/renderer' })
    })

    test('a build subtree emptied of files is as absent as a missing one', () => {
      freshRepo()
      rmSync(join(root, 'out', 'preload', 'index.js'))

      expect(checkBundleFreshness(root)).toEqual({ state: 'missing', path: 'out/preload' })
    })
  })

  describe('a build that no longer describes the working tree', () => {
    /**
     * The sequence this guard exists for, and the one its first version let through: build, edit a
     * renderer file, run `npm run dev` to look at it, quit, then reach for a bare Playwright run.
     * Development mode builds main and preload but serves the renderer from memory, so `out/main`
     * ends up newer than the edit while `out/renderer` still holds the pre-edit markup that
     * `loadFile` will hand to the window. Taking the newest file anywhere under `out/` reads that
     * as fresh, which is the original false pass reached through the most common command there is.
     */
    test('a dev run that rebuilt main but not the renderer does not count as a build', () => {
      freshRepo()
      fileAt('src/renderer/src/App.tsx', AFTER_BUILD)
      fileAt('out/main/index.js', AFTER_BUILD + 60)
      fileAt('out/main/chunks/core.js', AFTER_BUILD + 60)
      fileAt('out/preload/index.js', AFTER_BUILD + 60)

      const result = checkBundleFreshness(root)
      expect(result.state).toBe('stale')
      if (result.state !== 'stale') return
      expect(result.newestSource.path).toBe('src/renderer/src/App.tsx')
      expect(result.oldestBuilt.path).toMatch(/^out\/renderer\//)
      expect(result.oldestBuilt.mtimeMs).toBe(BUILT_AT * 1000)
    })

    test('a source file touched after the build names itself', () => {
      freshRepo()
      fileAt('src/renderer/src/App.tsx', AFTER_BUILD)

      const result = checkBundleFreshness(root)
      expect(result.state).toBe('stale')
      if (result.state !== 'stale') return
      expect(result.newestSource.path).toBe('src/renderer/src/App.tsx')
      expect(result.newestSource.mtimeMs).toBe(AFTER_BUILD * 1000)
      expect(result.oldestBuilt.mtimeMs).toBe(BUILT_AT * 1000)
    })

    test('a source file deleted after the build is caught by its parent directory', () => {
      freshRepo()
      rmSync(join(root, 'src', 'renderer', 'src', 'App.tsx'))

      const result = checkBundleFreshness(root)
      expect(result.state).toBe('stale')
      if (result.state !== 'stale') return
      expect(result.newestSource.path).toBe('src/renderer/src')
    })

    test('a source input as old as the build to the millisecond is not trusted', () => {
      freshRepo()
      fileAt('src/renderer/src/App.tsx', BUILT_AT)

      expect(checkBundleFreshness(root).state).toBe('stale')
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

    test('a compiler config touched after the build is stale, since it steers what is emitted', () => {
      freshRepo()
      fileAt('tsconfig.web.json', AFTER_BUILD)

      const result = checkBundleFreshness(root)
      expect(result.state).toBe('stale')
      if (result.state !== 'stale') return
      expect(result.newestSource.path).toBe('tsconfig.web.json')
    })

    test('an environment file appearing after the build is stale', () => {
      freshRepo()
      fileAt('.env.local', AFTER_BUILD)

      const result = checkBundleFreshness(root)
      expect(result.state).toBe('stale')
      if (result.state !== 'stale') return
      expect(result.newestSource.path).toBe('.env.local')
    })
  })

  describe('edits a build cannot be affected by', () => {
    test('a build newer than every source input is fresh', () => {
      freshRepo()

      expect(checkBundleFreshness(root)).toEqual({ state: 'fresh' })
    })

    test('editing only the specs leaves the build fresh', () => {
      freshRepo()
      fileAt('e2e/harness.ts', AFTER_BUILD)
      fileAt('e2e/prInbox.spec.ts', AFTER_BUILD)

      expect(checkBundleFreshness(root)).toEqual({ state: 'fresh' })
    })

    test.each([
      ['src/renderer/src/App.test.tsx'],
      ['src/renderer/src/App.spec.tsx'],
      ['src/renderer/src/__tests__/appBehaviour.ts']
    ])('editing %s alone leaves the build fresh, since no entry imports it', (path) => {
      freshRepo()
      fileAt(path, AFTER_BUILD)

      expect(checkBundleFreshness(root)).toEqual({ state: 'fresh' })
    })

    test('the module under test is not excused by the tests beside it', () => {
      freshRepo()
      fileAt('src/renderer/src/App.test.tsx', AFTER_BUILD)
      fileAt('src/renderer/src/App.tsx', AFTER_BUILD)

      const result = checkBundleFreshness(root)
      expect(result.state).toBe('stale')
      if (result.state !== 'stale') return
      expect(result.newestSource.path).toBe('src/renderer/src/App.tsx')
    })

    test('the scratch config a crashed build leaves behind is not a build input', () => {
      freshRepo()
      fileAt('electron.vite.config.ts.timestamp-1700000123-abc.mjs', AFTER_BUILD)

      expect(checkBundleFreshness(root)).toEqual({ state: 'fresh' })
    })
  })

  describe('a verdict that cannot be formed', () => {
    test('a source tree that cannot be walked is reported, not thrown', () => {
      freshRepo()
      symlinkSync(join(root, 'src', 'loop'), join(root, 'src', 'loop'))

      const result = checkBundleFreshness(root)
      expect(result.state).toBe('unknown')
      if (result.state !== 'unknown') return
      expect(result.path).toBe('src/loop')
      expect(result.reason).toMatch(/ELOOP/)
    })

    test('a checkout with no watched source input at all is not called fresh', () => {
      fileAt('out/main/index.js', BUILT_AT)
      fileAt('out/preload/index.js', BUILT_AT)
      fileAt('out/renderer/index.html', BUILT_AT)
      stampDirectories(BEFORE_BUILD)

      expect(checkBundleFreshness(root).state).toBe('unknown')
    })
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
    oldestBuilt: { path: 'out/renderer/index.html', mtimeMs: 1_700_000_000_000 }
  } as const
  const missing = { state: 'missing', path: 'out/renderer' } as const
  const unknown = { state: 'unknown', path: 'src/loop', reason: "ELOOP: too many symbolic links" } as const
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

  test('an incomplete build is refused, naming the part that is not there', () => {
    const action = resolveGuardAction(missing, undefined)

    expect(action.kind).toBe('fail')
    if (action.kind === 'proceed') return
    expect(action.message).toContain('out/renderer')
    expect(action.message).toContain('npm run build')
    expect(action.message).toContain('npm run e2e')
  })

  test('a verdict that could not be formed blames the guard, not the suite', () => {
    const action = resolveGuardAction(unknown, undefined)

    expect(action.kind).toBe('fail')
    if (action.kind === 'proceed') return
    expect(action.message).toContain('src/loop')
    expect(action.message).toContain('ELOOP')
    expect(action.message).toContain('E2E_ALLOW_STALE')
  })

  test('an exact opt-in downgrades a stale build to a warning that admits how stale it is', () => {
    const action = resolveGuardAction(stale, '1')

    expect(action.kind).toBe('warn')
    if (action.kind === 'proceed') return
    expect(action.message).toContain('E2E_ALLOW_STALE')
    expect(action.message).toContain('src/renderer/src/App.tsx')
    expect(action.message).toContain('out/renderer/index.html')
  })

  test('the opt-in also covers an unwalkable tree, the only escape from a verdict nobody can form', () => {
    const action = resolveGuardAction(unknown, '1')

    expect(action.kind).toBe('warn')
    if (action.kind === 'proceed') return
    expect(action.message).toContain('src/loop')
  })

  test.each([['true'], ['0'], [''], ['yes'], ['1 ']])(
    'the opt-in value %o is not the opt-in and the run is still refused',
    (value) => {
      expect(resolveGuardAction(stale, value).kind).toBe('fail')
      expect(resolveGuardAction(unknown, value).kind).toBe('fail')
    }
  )

  test('the opt-in cannot conjure a build that was never made', () => {
    expect(resolveGuardAction(missing, '1').kind).toBe('fail')
  })
})
