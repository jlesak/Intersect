import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { git } from './git'
import { createWorktreeManager, worktreesRoot } from './worktreeManager'

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
})
