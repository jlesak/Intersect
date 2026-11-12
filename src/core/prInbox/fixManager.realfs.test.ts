import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { canonicalizePath } from '../projects/paths'
import { createFixManager } from './fixManager'
import { git } from './git'
import { createWorktreeManager, fixWorktreesRoot } from './worktreeManager'

/**
 * The boot sweep of fix worktrees left behind by an earlier run, against real git: what decides
 * a removal is git's own view of the folder (registered, clean), which a mock cannot give. The
 * temp root is used as `tmpdir()` hands it out, so on macOS the workspace folder is spelled
 * `/var/...` while the sweep lists `/private/var/...`, and only canonical paths match them.
 */
describe('the boot sweep of orphaned fix worktrees', () => {
  let root: string
  let repoDir: string
  let userDataDir: string
  let fixRoot: string
  const warn = vi.fn()
  const info = vi.fn()

  const folder = (name: string): string => join(fixRoot, name)
  const addWorktree = async (name: string): Promise<string> => {
    await git(repoDir, ['worktree', 'add', '--quiet', '-b', `feature/${name}`, folder(name)])
    return folder(name)
  }
  const listed = (): Promise<string> => git(repoDir, ['worktree', 'list', '--porcelain'])
  const sweep = (workspaceFolders: string[]): Promise<void> =>
    createFixManager({
      userDataDir,
      ado: { getThreads: async () => [] },
      worktrees: createWorktreeManager(userDataDir),
      sessions: { whenWorkspaceExited: async () => 'exited' },
      workspaceFolders: () => workspaceFolders,
      hasOpenTabs: () => false,
      removeWorkspaceIfEmpty: () => true,
      onClosed: () => {},
      logger: { warn, info }
    }).pruneOrphans()

  beforeEach(async () => {
    warn.mockClear()
    info.mockClear()
    root = await mkdtemp(join(tmpdir(), 'intersect-fixsweep-'))
    repoDir = join(root, 'clone')
    userDataDir = join(root, 'userdata')
    fixRoot = fixWorktreesRoot(userDataDir)
    await git(root, ['init', '--quiet', '--initial-branch=main', repoDir])
    await git(repoDir, ['config', 'user.email', 'test@example.com'])
    await git(repoDir, ['config', 'user.name', 'Test'])
    await writeFile(join(repoDir, 'file.txt'), 'one\n')
    await git(repoDir, ['add', '.'])
    await git(repoDir, ['commit', '--quiet', '-m', 'first'])
    await mkdir(fixRoot, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('a clean worktree no workspace uses is removed, and its branch stays', async () => {
    const clean = await addWorktree('app-pr1')
    const sha = await git(clean, ['rev-parse', 'HEAD'])

    await sweep([repoDir])

    expect(existsSync(clean)).toBe(false)
    expect(await listed()).not.toContain('pr-fix-worktrees')
    expect(await git(repoDir, ['rev-parse', 'feature/app-pr1'])).toBe(sha)
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/removed/),
      expect.objectContaining({ data: expect.objectContaining({ path: canonicalizePath(clean) }) })
    )
  })

  test('a worktree with uncommitted or untracked work is kept and logged', async () => {
    const edited = await addWorktree('app-pr2')
    await writeFile(join(edited, 'file.txt'), 'edited\n')
    const untracked = await addWorktree('app-pr3')
    await writeFile(join(untracked, 'new.txt'), 'never added\n')

    await sweep([repoDir])

    expect(await git(edited, ['status', '--porcelain'])).toContain('file.txt')
    expect(existsSync(join(untracked, 'new.txt'))).toBe(true)
    expect(await listed()).toContain(canonicalizePath(edited))
    expect(await listed()).toContain(canonicalizePath(untracked))
    for (const path of [edited, untracked]) {
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/kept/),
        expect.objectContaining({
          data: expect.objectContaining({ path: canonicalizePath(path), outcome: 'dirty' })
        })
      )
    }
  })

  test('a worktree a workspace uses is never touched, clean or not', async () => {
    const clean = await addWorktree('app-pr4')
    const dirty = await addWorktree('app-pr5')
    await writeFile(join(dirty, 'new.txt'), 'work\n')

    // The non-canonical spelling, as a workspace row may hold it.
    await sweep([repoDir, clean, dirty])

    expect(existsSync(join(clean, 'file.txt'))).toBe(true)
    expect(existsSync(join(dirty, 'new.txt'))).toBe(true)
    expect(await listed()).toContain(canonicalizePath(clean))
    expect(warn).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
  })

  test('a folder that is not a registered worktree is kept and logged', async () => {
    const plain = folder('plain-pr6')
    await mkdir(plain)
    await writeFile(join(plain, 'x.txt'), 'x\n')
    // A whole clone sitting in the fix root: clean, but the main tree of its own repository.
    const clone = folder('clone-pr7')
    await git(root, ['clone', '--quiet', repoDir, clone])
    // A worktree whose registration was pruned away, leaving its `.git` file dangling.
    const stale = await addWorktree('stale-pr8')
    await rm(join(repoDir, '.git', 'worktrees', 'stale-pr8'), { recursive: true, force: true })
    // Not a folder at all: nothing the sweep looks at.
    await writeFile(join(fixRoot, '.DS_Store'), '')

    await sweep([repoDir])

    expect(existsSync(join(plain, 'x.txt'))).toBe(true)
    expect(existsSync(join(clone, 'file.txt'))).toBe(true)
    expect(existsSync(join(stale, 'file.txt'))).toBe(true)
    expect(warn).toHaveBeenCalledTimes(3)
    for (const path of [plain, clone, stale]) {
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/kept/),
        expect.objectContaining({
          data: expect.objectContaining({ path: canonicalizePath(path), outcome: 'failed' })
        })
      )
    }
  })

  test('with no fix root yet the sweep does nothing', async () => {
    await rm(fixRoot, { recursive: true, force: true })

    await expect(sweep([repoDir])).resolves.toBeUndefined()

    expect(warn).not.toHaveBeenCalled()
  })
})
