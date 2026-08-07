import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import type { PullRequest } from '@common/domain'
import { git } from './git'
import { createLocalDiffService, localChanges, localFileDiff, parseNumstat } from './localDiff'

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
  await mkdir(join(dir, 'nested', 'deep'), { recursive: true })
  await writeFile(join(dir, 'nested', 'deep', 'old.txt'), 'n1\nn2\nn3\nn4\nn5\n')
  await mkdir(join(dir, 'pkg', 'a'), { recursive: true })
  await writeFile(join(dir, 'pkg', 'a', 'mod.txt'), 'p1\np2\np3\np4\n')
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
  await git(dir, ['mv', 'keep.txt', 'renamed.txt']) // rename, root level, content untouched
  // Renames whose counts `--numstat` reports under a brace-compressed path rather than the plain
  // path `--name-status` gives, both edited so a merge that failed to join would read as 0 / 0.
  await git(dir, ['mv', 'nested/deep/old.txt', 'nested/deep/new.txt']) // nested/deep/{old => new}
  await writeFile(join(dir, 'nested', 'deep', 'new.txt'), 'n1\nn2\nn3\nn4\nEDITED\n')
  await mkdir(join(dir, 'pkg', 'b'), { recursive: true })
  await git(dir, ['mv', 'pkg/a/mod.txt', 'pkg/b/mod.txt']) // pkg/{a => b}/mod.txt
  await writeFile(join(dir, 'pkg', 'b', 'mod.txt'), 'p1\np2\np3\np4\np5\np6\n')
  await writeFile(join(dir, 'bin.dat'), Buffer.from([0x68, 0x00, 0x69])) // binary (NUL)
  await writeFile(join(dir, 'big.txt'), 'x'.repeat(600 * 1024)) // over MAX_DIFF_BYTES
  await writeFile(join(dir, 'přílöha.txt'), 'diakritika\n') // non-ASCII path (core.quotePath)
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'pr changes'])
  const source = await git(dir, ['rev-parse', 'HEAD'])

  return { dir, target, source }
}

/**
 * Every shape `git diff --numstat -M` was observed to emit for this invocation. The rename forms
 * are the ones that matter: `--numstat` names a rename by a compressed old-to-new path while
 * `--name-status` names it by two plain ones, so the key the merge joins on has to be rebuilt.
 */
describe('parseNumstat', () => {
  test('counts an ordinary file under its Azure DevOps-shaped path', () => {
    expect(parseNumstat('12\t3\tsrc/app/queue.ts\n')).toEqual(
      new Map([['/src/app/queue.ts', { added: 12, removed: 3 }]])
    )
  })

  test('a binary file counts as no lines at all rather than as NaN', () => {
    // git reports no line counts for a binary file, and a size summary that says NaN is worse
    // than one that leaves the file out of its arithmetic.
    expect(parseNumstat('-\t-\tassets/logo.png\n')).toEqual(
      new Map([['/assets/logo.png', { added: 0, removed: 0 }]])
    )
  })

  test('a rename with no common directory is keyed by its new path', () => {
    expect(parseNumstat('1\t1\told_name.txt => renamed_file.txt\n')).toEqual(
      new Map([['/renamed_file.txt', { added: 1, removed: 1 }]])
    )
  })

  test('a rename inside one directory expands the braces around the file name', () => {
    expect(parseNumstat('4\t2\ta/b/{one.txt => renamed.txt}\n')).toEqual(
      new Map([['/a/b/renamed.txt', { added: 4, removed: 2 }]])
    )
  })

  test('a rename between directories expands the braces around the directory', () => {
    expect(parseNumstat('0\t7\ta/{b => c}/two.txt\n')).toEqual(
      new Map([['/a/c/two.txt', { added: 0, removed: 7 }]])
    )
  })

  test('a rename into a directory that did not exist has an empty left side in the braces', () => {
    expect(parseNumstat('3\t0\t{ => moved}/file.txt\n')).toEqual(
      new Map([['/moved/file.txt', { added: 3, removed: 0 }]])
    )
  })

  test('paths with spaces survive both the plain and the braced rename form', () => {
    expect(parseNumstat('0\t0\t{dir one => dir two}/sp ace.txt\n')).toEqual(
      new Map([['/dir two/sp ace.txt', { added: 0, removed: 0 }]])
    )
  })

  test('blank lines and trailing whitespace produce no entries', () => {
    expect(parseNumstat('\n\n  \n')).toEqual(new Map())
    expect(parseNumstat('')).toEqual(new Map())
  })

  test('reads a whole multi-file output at once', () => {
    const raw = '2\t0\tadded.txt\n-\t-\tblob.bin\n0\t0\t{dir one => dir two}/sp ace.txt\n0\t1\tkept.txt\n'
    expect(parseNumstat(raw)).toEqual(
      new Map([
        ['/added.txt', { added: 2, removed: 0 }],
        ['/blob.bin', { added: 0, removed: 0 }],
        ['/dir two/sp ace.txt', { added: 0, removed: 0 }],
        ['/kept.txt', { added: 0, removed: 1 }]
      ])
    )
  })
})

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

    expect(byPath.get('/a.txt')?.changeType).toBe('edit')
    expect(byPath.get('/added.txt')?.changeType).toBe('add')
    expect(byPath.get('/gone.txt')?.changeType).toBe('delete')
    expect(byPath.get('/renamed.txt')?.changeType).toBe('rename')
    expect(byPath.get('/renamed.txt')?.originalPath).toBe('/keep.txt')
    // Target-only change never appears in the PR diff.
    expect(byPath.has('/target-only.txt')).toBe(false)
  })

  test('non-ASCII paths round-trip unquoted (core.quotePath disabled)', async () => {
    const changes = await localChanges(repo.dir, repo.target, repo.source)
    const byPath = new Map(changes.map((c) => [c.path, c]))

    expect(byPath.get('/přílöha.txt')?.changeType).toBe('add')
  })

  test('every change carries the lines it added and removed', async () => {
    const changes = await localChanges(repo.dir, repo.target, repo.source)
    const byPath = new Map(changes.map((c) => [c.path, c]))

    expect(byPath.get('/a.txt')).toMatchObject({ added: 1, removed: 1 })
    expect(byPath.get('/added.txt')).toMatchObject({ added: 1, removed: 0 })
    expect(byPath.get('/gone.txt')).toMatchObject({ added: 0, removed: 1 })
  })

  test('a rename git names differently in the two outputs still gets its counts', async () => {
    const changes = await localChanges(repo.dir, repo.target, repo.source)
    const byPath = new Map(changes.map((c) => [c.path, c]))

    // Both were edited, so a merge key that did not line up would leave them at 0 / 0 - which is
    // exactly what a silently failed join looks like.
    expect(byPath.get('/nested/deep/new.txt')).toMatchObject({
      changeType: 'rename',
      added: 1,
      removed: 1
    })
    expect(byPath.get('/pkg/b/mod.txt')).toMatchObject({
      changeType: 'rename',
      added: 2,
      removed: 0
    })
  })

  test('a binary file is listed with no lines counted, never with NaN', async () => {
    const changes = await localChanges(repo.dir, repo.target, repo.source)
    const bin = changes.find((c) => c.path === '/bin.dat')

    expect(bin).toMatchObject({ added: 0, removed: 0 })
    expect(Number.isNaN(bin!.added)).toBe(false)
    // The totals a size summary is built from stay arithmetic.
    const total = changes.reduce((sum, c) => sum + c.added + c.removed, 0)
    expect(Number.isFinite(total)).toBe(true)
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
    const diff = await localFileDiff(repo.dir, input('/a.txt', 'edit'))
    expect(diff.original).toContain('alpha')
    expect(diff.original).not.toContain('edited')
    expect(diff.modified).toContain('alpha edited')
    expect(diff.binary).toBe(false)
    expect(diff.tooLarge).toBe(false)
  })

  test('add has an empty left side', async () => {
    const diff = await localFileDiff(repo.dir, input('/added.txt', 'add'))
    expect(diff.original).toBe('')
    expect(diff.modified).toContain('new')
  })

  test('delete has an empty right side', async () => {
    const diff = await localFileDiff(repo.dir, input('/gone.txt', 'delete'))
    expect(diff.original).toContain('gone')
    expect(diff.modified).toBe('')
  })

  test('rename reads the left side from the original path at the merge base', async () => {
    const diff = await localFileDiff(repo.dir, input('/renamed.txt', 'rename', '/keep.txt'))
    expect(diff.original).toContain('keep')
    expect(diff.modified).toContain('keep')
  })

  test('binary file is flagged and its content withheld', async () => {
    const diff = await localFileDiff(repo.dir, input('/bin.dat', 'add'))
    expect(diff.binary).toBe(true)
    expect(diff.modified).toBe('')
  })

  test('oversize file is flagged and its content withheld', async () => {
    const diff = await localFileDiff(repo.dir, input('/big.txt', 'add'))
    expect(diff.tooLarge).toBe(true)
    expect(diff.modified).toBe('')
  })

  test('non-ASCII path reads its blob (real UTF-8, not C-quoted)', async () => {
    const diff = await localFileDiff(repo.dir, input('/přílöha.txt', 'add'))
    expect(diff.modified).toContain('diakritika')
  })

  test('language is derived from the path', async () => {
    const diff = await localFileDiff(repo.dir, input('/a.txt', 'edit'))
    expect(diff.language).toBe('plaintext')
  })
})

describe('localFileDiff with a blob larger than gitRaw maxBuffer', () => {
  let dir: string
  let target: string
  let source: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ixdiff-huge-'))
    await git(dir, ['init', '-q', '-b', 'main'])
    await git(dir, ['config', 'user.email', 't@t'])
    await git(dir, ['config', 'user.name', 'T'])
    await git(dir, ['config', 'commit.gpgsign', 'false'])
    await writeFile(join(dir, 'seed.txt'), 'seed\n')
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-q', '-m', 'base'])
    target = await git(dir, ['rev-parse', 'HEAD'])
    // A blob above gitRaw's 32MB maxBuffer, so `git show` rejects with maxBuffer-exceeded.
    await writeFile(join(dir, 'huge.txt'), 'x'.repeat(33 * 1024 * 1024))
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-q', '-m', 'huge'])
    source = await git(dir, ['rev-parse', 'HEAD'])
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('is flagged tooLarge instead of throwing a hard error', async () => {
    const diff = await localFileDiff(dir, {
      targetCommit: target,
      sourceCommit: source,
      filePath: '/huge.txt',
      originalPath: null,
      changeType: 'add'
    })
    expect(diff.tooLarge).toBe(true)
    expect(diff.binary).toBe(false)
    expect(diff.original).toBe('')
    expect(diff.modified).toBe('')
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
    expect(changes.some((c) => c.path === '/added.txt')).toBe(true)

    // A second call reuses the cached repo resolution rather than probing folders again.
    await svc.getChanges(prFor(), ['/some/folder'])
    expect(resolveRepoDir).toHaveBeenCalledTimes(1)
  })

  test('getFileDiff returns both sides for a changed file', async () => {
    const svc = createLocalDiffService({ resolveRepoDir: async () => repo.dir })
    const diff = await svc.getFileDiff(prFor(), '/a.txt', ['/some/folder'])
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
