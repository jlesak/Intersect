import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { canonicalizePath, worktreeParentRoot } from './paths'

describe('project path helpers', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'intersect-paths-'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('canonicalizePath resolves symlinks of existing paths', () => {
    const real = join(root, 'real-folder')
    mkdirSync(real)
    const link = join(root, 'link-folder')
    symlinkSync(real, link)
    expect(canonicalizePath(link)).toBe(canonicalizePath(real))
  })

  test('canonicalizePath falls back to the normalized absolute form for missing paths', () => {
    const missing = join(root, 'not-cloned-yet', '..', 'not-cloned-yet', 'repo')
    expect(canonicalizePath(missing)).toBe(join(canonicalizePath(root), 'not-cloned-yet', 'repo'))
  })

  test('worktreeParentRoot finds the parent repository from inside a linked worktree', () => {
    const repo = join(root, 'main-repo')
    mkdirSync(repo)
    execFileSync('git', ['-C', repo, 'init', '-q'])
    execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'init', '-q'], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t'
      }
    })
    const wt = join(root, 'linked-wt')
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', wt])
    const nested = join(wt, 'src', 'deep')
    mkdirSync(nested, { recursive: true })

    expect(worktreeParentRoot(wt)).toBe(canonicalizePath(repo))
    expect(worktreeParentRoot(nested)).toBe(canonicalizePath(repo))
    // The main checkout itself is not a worktree.
    expect(worktreeParentRoot(repo)).toBeNull()
    expect(worktreeParentRoot(join(repo, 'sub'))).toBeNull()
  })

  test('worktreeParentRoot ignores non-worktree folders and submodule-style pointers', () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    expect(worktreeParentRoot(plain)).toBeNull()
    expect(worktreeParentRoot(join(root, 'does', 'not', 'exist'))).toBeNull()

    const submodule = join(root, 'submodule-like')
    mkdirSync(submodule)
    writeFileSync(join(submodule, '.git'), 'gitdir: ../parent/.git/modules/submodule-like\n')
    expect(worktreeParentRoot(submodule)).toBeNull()
  })
})
