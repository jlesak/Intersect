import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createCloneQueue,
  fixWorktreeDirName,
  fixWorktreePath,
  fixWorktreesRoot,
  isFixWorktreePath,
  sourceBranch,
  worktreesRoot
} from './worktreeManager'

/**
 * Two reviews starting at once on one clone would otherwise run `git fetch` and `git worktree add`
 * concurrently in the same repository, which fails on its index and ref locks. The queue is what
 * makes that impossible, so its ordering is pinned here rather than left to a timing-dependent
 * integration test.
 */
describe('the per-clone queue', () => {
  const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve = (): void => {}
    const promise = new Promise<void>((r) => (resolve = r))
    return { promise, resolve }
  }

  test('work on one clone never overlaps', async () => {
    const onClone = createCloneQueue()
    const events: string[] = []
    const first = deferred()

    const a = onClone('/repo', async () => {
      events.push('a:start')
      await first.promise
      events.push('a:end')
    })
    const b = onClone('/repo', async () => {
      events.push('b:start')
    })

    // The second job has not begun while the first is still in flight.
    await Promise.resolve()
    expect(events).toEqual(['a:start'])

    first.resolve()
    await Promise.all([a, b])
    expect(events).toEqual(['a:start', 'a:end', 'b:start'])
  })

  test('work on different clones runs in parallel', async () => {
    const onClone = createCloneQueue()
    const events: string[] = []
    const held = deferred()

    const a = onClone('/repo-a', async () => {
      events.push('a:start')
      await held.promise
    })
    const b = onClone('/repo-b', async () => {
      events.push('b:start')
    })

    await b
    expect(events).toEqual(['a:start', 'b:start'])
    held.resolve()
    await a
  })

  test('a failed job releases the queue instead of stalling every later review', async () => {
    const onClone = createCloneQueue()

    await expect(
      onClone('/repo', () => Promise.reject(new Error('fetch failed')))
    ).rejects.toThrow(/fetch failed/)

    await expect(onClone('/repo', async () => 'went through')).resolves.toBe('went through')
  })

  test('the caller sees its own result, not the previous job’s', async () => {
    const onClone = createCloneQueue()

    const [first, second] = await Promise.all([
      onClone('/repo', async () => 'first'),
      onClone('/repo', async () => 'second')
    ])

    expect([first, second]).toEqual(['first', 'second'])
  })
})

/**
 * Where a fix worktree lives and how it is recognised. Everything is compared in canonical form,
 * because the same folder reaches the core under two spellings on macOS (`/var/folders` and
 * `/private/var/folders`), and a symlinked profile folder does the same.
 */
describe('fix worktree paths', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'intersect-fixpath-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('the folder is named after the repository and the pull request', () => {
    expect(fixWorktreeDirName({ repositoryName: 'intersect-app', prId: 501 })).toBe(
      'intersect-app-pr501'
    )
    expect(fixWorktreeDirName({ repositoryName: 'My Repo/x', prId: 7 })).toBe('my-repo-x-pr7')
    const long = fixWorktreeDirName({ repositoryName: 'a'.repeat(80), prId: 1 })
    expect(long).toBe(`${'a'.repeat(40)}-pr1`)
  })

  test('fix worktrees live under their own root, apart from review worktrees', () => {
    expect(fixWorktreesRoot('/u')).toBe(join('/u', 'pr-fix-worktrees'))
    expect(fixWorktreesRoot('/u')).not.toBe(worktreesRoot('/u'))
  })

  test('the path is canonical even when the profile folder is reached through a symlink', () => {
    const real = join(root, 'real')
    mkdirSync(real)
    const link = join(root, 'link')
    symlinkSync(real, link)

    const path = fixWorktreePath(link, { repositoryName: 'intersect-app', prId: 501 })
    expect(path).toBe(join(realpathSync(real), 'pr-fix-worktrees', 'intersect-app-pr501'))
  })

  test('a fix worktree is recognised under either spelling of its root', () => {
    const real = join(root, 'real')
    mkdirSync(join(real, 'pr-fix-worktrees', 'x-pr1'), { recursive: true })
    const link = join(root, 'link')
    symlinkSync(real, link)

    expect(isFixWorktreePath(link, join(real, 'pr-fix-worktrees', 'x-pr1'))).toBe(true)
    expect(isFixWorktreePath(real, join(link, 'pr-fix-worktrees', 'x-pr1'))).toBe(true)
    // A worktree removed since still counts, so a resume into a missing folder stays guarded.
    expect(isFixWorktreePath(real, join(link, 'pr-fix-worktrees', 'gone-pr2'))).toBe(true)
    expect(isFixWorktreePath(real, join(real, 'pr-fix-worktrees'))).toBe(false)
    expect(isFixWorktreePath(real, join(real, 'pr-fix-worktrees-other', 'x'))).toBe(false)
    expect(isFixWorktreePath(real, join(real, 'pr-review-worktrees', 'x'))).toBe(false)
  })

  test('the source must be a branch', () => {
    expect(sourceBranch('refs/heads/feature/rate-limit')).toBe('feature/rate-limit')
    expect(() => sourceBranch('refs/tags/v1')).toThrow(/not a branch/)
    expect(() => sourceBranch('refs/heads/')).toThrow(/not a branch/)
  })
})
