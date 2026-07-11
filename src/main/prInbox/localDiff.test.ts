import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import type { PullRequest } from '@common/domain'
import { git } from './git'
import { createLocalDiffService, localChanges, localFileDiff } from './localDiff'

/**
 * A throwaway repo with a base commit, a target branch that diverges with its own change, and a
 * source branch that carries the PR's changes (add/edit/delete/rename). Three-dot (merge-base)
 * diffing must show only the source-side PR changes, never the target-only change.
 */
async function makeRepo(): Promise<{
  dir: string
  target: string
  source: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'ixdiff-'))
  await git(dir, ['init', '-q', '-b', 'main'])
  await git(dir, ['config', 'user.email', 't@t'])
  await git(dir, ['config', 'user.name', 'T'])
  await git(dir, ['config', 'commit.gpgsign', 'false'])

  await writeFile(join(dir, 'a.txt'), 'alpha\n')
  await writeFile(join(dir, 'keep.txt'), 'keep\n')
  await writeFile(join(dir, 'gone.txt'), 'gone\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'base'])
  const base = await git(dir, ['rev-parse', 'HEAD'])

  // Target branch: a change that must NOT leak into the PR diff.
  await git(dir, ['checkout', '-q', '-b', 'target'])
  await writeFile(join(dir, 'target-only.txt'), 'noise\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'target noise'])
  const target = await git(dir, ['rev-parse', 'HEAD'])

  // Source branch off the base: the PR's actual changes.
  await git(dir, ['checkout', '-q', base])
  await git(dir, ['checkout', '-q', '-b', 'source'])
  await writeFile(join(dir, 'a.txt'), 'alpha edited\n') // edit
  await writeFile(join(dir, 'added.txt'), 'new\n') // add
  await rm(join(dir, 'gone.txt')) // delete
  await git(dir, ['mv', 'keep.txt', 'renamed.txt']) // rename
  await writeFile(join(dir, 'bin.dat'), Buffer.from([0x68, 0x00, 0x69])) // binary (NUL)
  await writeFile(join(dir, 'big.txt'), 'x'.repeat(600 * 1024)) // over MAX_DIFF_BYTES
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'pr changes'])
  const source = await git(dir, ['rev-parse', 'HEAD'])

  return { dir, target, source }
}

describe('localChanges', () => {
  let repo: { dir: string; target: string; source: string }

  beforeAll(async () => {
    repo = await makeRepo()
  })
  afterAll(async () => {
    await rm(repo.dir, { recursive: true, force: true })
  })

  test('lists the PR changes with change types, ignoring target-only changes (three-dot)', async () => {
    const changes = await localChanges(repo.dir, repo.target, repo.source)
    const byPath = new Map(changes.map((c) => [c.path, c]))

    expect(byPath.get('a.txt')?.changeType).toBe('edit')
    expect(byPath.get('added.txt')?.changeType).toBe('add')
    expect(byPath.get('gone.txt')?.changeType).toBe('delete')
    expect(byPath.get('renamed.txt')?.changeType).toBe('rename')
    expect(byPath.get('renamed.txt')?.originalPath).toBe('keep.txt')
    // Target-only change never appears in the PR diff.
    expect(byPath.has('target-only.txt')).toBe(false)
  })
})

describe('localFileDiff', () => {
  let repo: { dir: string; target: string; source: string }

  beforeAll(async () => {
    repo = await makeRepo()
  })
  afterAll(async () => {
    await rm(repo.dir, { recursive: true, force: true })
  })

  const input = (
    filePath: string,
    changeType: 'add' | 'edit' | 'delete' | 'rename',
    originalPath: string | null = null
  ): Parameters<typeof localFileDiff>[1] => ({
    targetCommit: repo.target,
    sourceCommit: repo.source,
    filePath,
    originalPath,
    changeType
  })

  test('edit shows merge-base content on the left and source content on the right', async () => {
    const diff = await localFileDiff(repo.dir, input('a.txt', 'edit'))
    expect(diff.original).toContain('alpha')
    expect(diff.original).not.toContain('edited')
    expect(diff.modified).toContain('alpha edited')
    expect(diff.binary).toBe(false)
    expect(diff.tooLarge).toBe(false)
  })

  test('add has an empty left side', async () => {
    const diff = await localFileDiff(repo.dir, input('added.txt', 'add'))
    expect(diff.original).toBe('')
    expect(diff.modified).toContain('new')
  })

  test('delete has an empty right side', async () => {
    const diff = await localFileDiff(repo.dir, input('gone.txt', 'delete'))
    expect(diff.original).toContain('gone')
    expect(diff.modified).toBe('')
  })

  test('rename reads the left side from the original path at the merge base', async () => {
    const diff = await localFileDiff(repo.dir, input('renamed.txt', 'rename', 'keep.txt'))
    expect(diff.original).toContain('keep')
    expect(diff.modified).toContain('keep')
  })

  test('binary file is flagged and its content withheld', async () => {
    const diff = await localFileDiff(repo.dir, input('bin.dat', 'add'))
    expect(diff.binary).toBe(true)
    expect(diff.modified).toBe('')
  })

  test('oversize file is flagged and its content withheld', async () => {
    const diff = await localFileDiff(repo.dir, input('big.txt', 'add'))
    expect(diff.tooLarge).toBe(true)
    expect(diff.modified).toBe('')
  })

  test('language is derived from the path', async () => {
    const diff = await localFileDiff(repo.dir, input('a.txt', 'edit'))
    expect(diff.language).toBe('plaintext')
  })
})

describe('createLocalDiffService', () => {
  let repo: { dir: string; target: string; source: string }

  beforeAll(async () => {
    repo = await makeRepo()
  })
  afterAll(async () => {
    await rm(repo.dir, { recursive: true, force: true })
  })

  const prFor = (): PullRequest =>
    ({
      repositoryId: 'repo-1',
      prId: 42,
      repositoryName: 'spot-backend',
      sourceCommitId: repo.source,
      targetCommitId: repo.target,
      sourceRefName: 'refs/heads/feature',
      targetRefName: 'refs/heads/main'
    }) as PullRequest

  test('getChanges resolves the clone once and lists the PR changes', async () => {
    const resolveRepoDir = vi.fn(async () => repo.dir)
    const svc = createLocalDiffService({ resolveRepoDir })

    const changes = await svc.getChanges(prFor(), ['/some/folder'])
    expect(changes.some((c) => c.path === 'added.txt')).toBe(true)

    // A second call reuses the cached repo resolution rather than probing folders again.
    await svc.getChanges(prFor(), ['/some/folder'])
    expect(resolveRepoDir).toHaveBeenCalledTimes(1)
  })

  test('getFileDiff returns both sides for a changed file', async () => {
    const svc = createLocalDiffService({ resolveRepoDir: async () => repo.dir })
    const diff = await svc.getFileDiff(prFor(), 'a.txt', ['/some/folder'])
    expect(diff.original).toContain('alpha')
    expect(diff.modified).toContain('alpha edited')
  })

  test('surfaces the missing-clone error', async () => {
    const svc = createLocalDiffService({
      resolveRepoDir: async () => {
        throw new Error('No local clone found for repository "spot-backend".')
      }
    })
    await expect(svc.getChanges(prFor(), [])).rejects.toThrow(/No local clone/)
  })
})
