import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { git } from './git'
import {
  createCloneQueue,
  createWorktreeManager,
  fixWorktreePath,
  fixWorktreesRoot,
  worktreesRoot
} from './worktreeManager'

/**
 * Real git, because the bug this guards against only exists in real git: two reviews starting at
 * once on one clone contend on that repository's index and ref locks. A mocked git cannot fail
 * that way, so it cannot prove the fix either.
 */
describe('creating review worktrees in one clone', () => {
  let root: string
  let repoDir: string
  let userDataDir: string
  let commit: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intersect-worktree-'))
    repoDir = join(root, 'clone')
    userDataDir = join(root, 'userdata')
    await git(root, ['init', '--quiet', 'clone'])
    await git(repoDir, ['config', 'user.email', 'test@example.com'])
    await git(repoDir, ['config', 'user.name', 'Test'])
    await writeFile(join(repoDir, 'file.txt'), 'one\n')
    await git(repoDir, ['add', '.'])
    await git(repoDir, ['commit', '--quiet', '-m', 'first'])
    commit = await git(repoDir, ['rev-parse', 'HEAD'])
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('two reviews started at once both get a worktree', async () => {
    const worktrees = createWorktreeManager(userDataDir)
    const create = (dirName: string, prId: number): Promise<string> =>
      worktrees.createWorktree({
        repoDir,
        dirName,
        sourceCommit: commit,
        sourceRefName: 'refs/heads/main',
        prId
      })

    const [first, second] = await Promise.all([create('wt-a', 1), create('wt-b', 2)])

    expect(first).toBe(join(worktreesRoot(userDataDir), 'wt-a'))
    expect(second).toBe(join(worktreesRoot(userDataDir), 'wt-b'))
    expect(existsSync(join(first, 'file.txt'))).toBe(true)
    expect(existsSync(join(second, 'file.txt'))).toBe(true)

    const listed = await git(repoDir, ['worktree', 'list', '--porcelain'])
    expect(listed).toContain(first)
    expect(listed).toContain(second)
  })

  test('removing one review’s worktree leaves the other checked out', async () => {
    const worktrees = createWorktreeManager(userDataDir)
    const first = await worktrees.createWorktree({
      repoDir,
      dirName: 'wt-a',
      sourceCommit: commit,
      sourceRefName: 'refs/heads/main',
      prId: 1
    })
    const second = await worktrees.createWorktree({
      repoDir,
      dirName: 'wt-b',
      sourceCommit: commit,
      sourceRefName: 'refs/heads/main',
      prId: 2
    })

    await worktrees.removeWorktree(repoDir, first)

    expect(existsSync(first)).toBe(false)
    expect(existsSync(join(second, 'file.txt'))).toBe(true)
    expect(await git(repoDir, ['worktree', 'list', '--porcelain'])).toContain(second)
  })

  test('the boot sweep of review worktrees leaves fix worktrees alone', async () => {
    const worktrees = createWorktreeManager(userDataDir)
    await git(repoDir, ['branch', 'feature/fix'])
    const fixPath = fixWorktreePath(userDataDir, { repositoryName: 'clone', prId: 9 })
    await mkdir(fixWorktreesRoot(userDataDir), { recursive: true })
    await git(repoDir, ['worktree', 'add', fixPath, 'feature/fix'])
    await writeFile(join(fixPath, 'kept.txt'), 'uncommitted work\n')

    await worktrees.pruneStale([repoDir])

    expect(existsSync(join(fixPath, 'kept.txt'))).toBe(true)
    expect(await git(repoDir, ['worktree', 'list', '--porcelain'])).toContain(fixPath)
  })
})

/**
 * Fixing my own pull request works on its source branch, in a worktree of my clone. Real git with
 * a real origin, because what is under test is how git treats branches, tracking refs and
 * worktrees. The temp root is used as `tmpdir()` hands it out, never realpath'd, so on macOS the
 * `/var` to `/private/var` symlink is part of what the code has to cope with.
 */
describe('fix worktrees on the pull request branch', () => {
  const BRANCH = 'feature/rate-limit'
  let root: string
  let seedDir: string
  let originDir: string
  let repoDir: string
  let userDataDir: string
  let fixPath: string

  const commitIn = async (dir: string, file: string, text: string): Promise<string> => {
    await writeFile(join(dir, file), text)
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '--quiet', '-m', `edit ${file}`])
    return git(dir, ['rev-parse', 'HEAD'])
  }
  const configure = async (dir: string): Promise<void> => {
    await git(dir, ['config', 'user.email', 'test@example.com'])
    await git(dir, ['config', 'user.name', 'Test'])
  }
  /** A commit pushed to origin's branch by someone else, fetched by nobody yet. */
  const pushFromSeed = async (file: string): Promise<string> => {
    await git(seedDir, ['checkout', '--quiet', BRANCH])
    const sha = await commitIn(seedDir, file, `${file}\n`)
    await git(seedDir, ['push', '--quiet', 'origin', BRANCH])
    return sha
  }
  const headOf = (dir: string): Promise<string> => git(dir, ['rev-parse', 'HEAD'])
  const branchOf = (dir: string): Promise<string> => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const listed = (): Promise<string> => git(repoDir, ['worktree', 'list', '--porcelain'])

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intersect-fixwt-'))
    seedDir = join(root, 'seed')
    originDir = join(root, 'intersect-app.git')
    repoDir = join(root, 'clone')
    userDataDir = join(root, 'userdata')
    await git(root, ['init', '--quiet', '--bare', '--initial-branch=main', originDir])
    await git(root, ['init', '--quiet', '--initial-branch=main', seedDir])
    await configure(seedDir)
    await commitIn(seedDir, 'file.txt', 'one\n')
    await git(seedDir, ['remote', 'add', 'origin', originDir])
    await git(seedDir, ['push', '--quiet', 'origin', 'main'])
    await git(seedDir, ['checkout', '--quiet', '-b', BRANCH])
    await commitIn(seedDir, 'feature.txt', 'feature\n')
    await git(seedDir, ['push', '--quiet', 'origin', BRANCH])
    await git(root, ['clone', '--quiet', originDir, repoDir])
    await configure(repoDir)
    fixPath = fixWorktreePath(userDataDir, { repositoryName: 'intersect-app', prId: 501 })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const create = (worktrees = createWorktreeManager(userDataDir)) =>
    worktrees.createBranchWorktree({ repoDir, path: fixPath, branch: BRANCH })

  test('with no local branch yet, the worktree tracks origin’s branch and the clone stays put', async () => {
    const cloneHead = await headOf(repoDir)
    const originSha = await pushFromSeed('more.txt')

    await expect(create()).resolves.toEqual({ diverged: false })

    expect(await branchOf(fixPath)).toBe(BRANCH)
    expect(await headOf(fixPath)).toBe(originSha)
    expect(await git(fixPath, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe(`origin/${BRANCH}`)
    expect(await branchOf(repoDir)).toBe('main')
    expect(await headOf(repoDir)).toBe(cloneHead)
  })

  test('a local branch behind origin is fast-forwarded', async () => {
    await git(repoDir, ['branch', BRANCH, `origin/${BRANCH}`])
    const originSha = await pushFromSeed('more.txt')

    await expect(create()).resolves.toEqual({ diverged: false })

    expect(await headOf(fixPath)).toBe(originSha)
  })

  test('a local branch only ahead of origin keeps its commits', async () => {
    await git(repoDir, ['checkout', '--quiet', '-b', BRANCH, `origin/${BRANCH}`])
    const localSha = await commitIn(repoDir, 'local.txt', 'mine\n')
    await git(repoDir, ['checkout', '--quiet', 'main'])

    await expect(create()).resolves.toEqual({ diverged: false })

    expect(await headOf(fixPath)).toBe(localSha)
  })

  test('a local branch diverged from origin is reported and left untouched', async () => {
    await git(repoDir, ['checkout', '--quiet', '-b', BRANCH, `origin/${BRANCH}`])
    const localSha = await commitIn(repoDir, 'local.txt', 'mine\n')
    await git(repoDir, ['checkout', '--quiet', 'main'])
    const originSha = await pushFromSeed('theirs.txt')

    await expect(create()).resolves.toEqual({ diverged: true })

    expect(await headOf(fixPath)).toBe(localSha)
    expect(await git(repoDir, ['rev-parse', `refs/remotes/origin/${BRANCH}`])).toBe(originSha)
  })

  test('a branch checked out in the clone is refused, naming that folder', async () => {
    await git(repoDir, ['checkout', '--quiet', '-b', BRANCH, `origin/${BRANCH}`])

    await expect(create()).rejects.toThrow(
      `Branch ${BRANCH} is checked out in ${realpathSync(repoDir)}`
    )

    expect(existsSync(fixPath)).toBe(false)
    expect(await listed()).not.toContain('pr-fix-worktrees')
  })

  test('a second start reuses the worktree the first one made', async () => {
    const worktrees = createWorktreeManager(userDataDir)
    await create(worktrees)
    await writeFile(join(fixPath, 'note.txt'), 'work in progress\n')

    await expect(create(worktrees)).resolves.toEqual({ diverged: false })

    expect(existsSync(join(fixPath, 'note.txt'))).toBe(true)
  })

  test('a worktree folder deleted by hand is checked out afresh, not reused as missing', async () => {
    const worktrees = createWorktreeManager(userDataDir)
    await create(worktrees)
    // What the failed-removal toast asks the user to do; git still has the worktree registered.
    await rm(fixPath, { recursive: true, force: true })

    await expect(create(worktrees)).resolves.toEqual({ diverged: false })

    expect(existsSync(join(fixPath, 'feature.txt'))).toBe(true)
    expect(await branchOf(fixPath)).toBe(BRANCH)
  })

  test('a folder left over at the worktree path is refused rather than reused', async () => {
    await mkdir(fixPath, { recursive: true })
    await writeFile(join(fixPath, 'stray.txt'), 'left behind\n')

    await expect(create()).rejects.toThrow(/left over from an incomplete removal/)

    expect(existsSync(join(fixPath, 'stray.txt'))).toBe(true)
  })

  test('a clean worktree is removed and its commits stay on the branch', async () => {
    const worktrees = createWorktreeManager(userDataDir)
    await create(worktrees)
    const fixSha = await commitIn(fixPath, 'fix.txt', 'fixed\n')

    await expect(worktrees.removeCleanWorktree(fixPath)).resolves.toMatchObject({
      outcome: 'removed'
    })

    expect(existsSync(fixPath)).toBe(false)
    expect(await git(repoDir, ['rev-parse', BRANCH])).toBe(fixSha)
    expect(await listed()).not.toContain('pr-fix-worktrees')
  })

  test('uncommitted or untracked files keep the worktree', async () => {
    const worktrees = createWorktreeManager(userDataDir)
    await create(worktrees)

    await writeFile(join(fixPath, 'feature.txt'), 'edited\n')
    await expect(worktrees.removeCleanWorktree(fixPath)).resolves.toMatchObject({
      outcome: 'dirty'
    })
    expect(existsSync(join(fixPath, 'feature.txt'))).toBe(true)

    await git(fixPath, ['checkout', '--', 'feature.txt'])
    await writeFile(join(fixPath, 'untracked.txt'), 'new\n')
    await expect(worktrees.removeCleanWorktree(fixPath)).resolves.toMatchObject({
      outcome: 'dirty'
    })
    expect(existsSync(join(fixPath, 'untracked.txt'))).toBe(true)
    expect(await listed()).toContain('pr-fix-worktrees')
  })

  test('a folder that is not a worktree fails with git’s reason, never as dirty', async () => {
    const worktrees = createWorktreeManager(userDataDir)
    const plain = join(root, 'plain')
    await mkdir(plain)
    await writeFile(join(plain, 'x.txt'), 'x\n')

    const result = await worktrees.removeCleanWorktree(plain)

    expect(result.outcome).toBe('failed')
    expect(result.detail).toMatch(/not a git repository/i)
    expect(existsSync(join(plain, 'x.txt'))).toBe(true)
  })

  test('removal does not wait behind work queued on the same clone', async () => {
    const onClone = createCloneQueue()
    const worktrees = createWorktreeManager(userDataDir, { onClone })
    await create(worktrees)
    let release = (): void => {}
    const held = onClone(repoDir, () => new Promise<void>((resolve) => (release = resolve)))

    await expect(worktrees.removeCleanWorktree(fixPath)).resolves.toMatchObject({
      outcome: 'removed'
    })

    release()
    await held
  })
})
