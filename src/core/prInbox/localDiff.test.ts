import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import type { PullRequest } from '@common/domain'
import { git } from './git'
import {
  createLocalDiffService,
  localChanges,
  localFileDiff,
  parseNameStatus,
  parseNumstat,
  withCounts
} from './localDiff'

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
  await mkdir(join(dir, 'src', 'utils'), { recursive: true })
  await writeFile(join(dir, 'src', 'utils', 'helpers.ts'), 'h1\nh2\nh3\n')
  await mkdir(join(dir, 'deep', 'one'), { recursive: true })
  await writeFile(join(dir, 'deep', 'one', 'toroot.txt'), 'r1\nr2\n')
  await writeFile(join(dir, 'has"quote.txt'), 'q1\n')
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
  // Every rename shape at once, each one edited so that a file whose counts failed to join would
  // read as 0 / 0 - which is exactly what a silently broken merge looks like on the screen.
  await git(dir, ['mv', 'nested/deep/old.txt', 'nested/deep/new.txt']) // renamed in place
  await writeFile(join(dir, 'nested', 'deep', 'new.txt'), 'n1\nn2\nn3\nn4\nEDITED\n')
  await mkdir(join(dir, 'pkg', 'b'), { recursive: true })
  await git(dir, ['mv', 'pkg/a/mod.txt', 'pkg/b/mod.txt']) // moved sideways, name kept
  await writeFile(join(dir, 'pkg', 'b', 'mod.txt'), 'p1\np2\np3\np4\np5\np6\n')
  await git(dir, ['mv', 'src/utils/helpers.ts', 'src/helpers.ts']) // moved up a level, name kept
  await writeFile(join(dir, 'src', 'helpers.ts'), 'h1\nh2\nh3\nh4\n')
  await git(dir, ['mv', 'deep/one/toroot.txt', 'toroot.txt']) // moved to the repo root
  await writeFile(join(dir, 'toroot.txt'), 'r1\nR2\n')
  await writeFile(join(dir, 'has"quote.txt'), 'q1\nq2\n') // a path git C-quotes unless asked not to
  await writeFile(join(dir, 'bin.dat'), Buffer.from([0x68, 0x00, 0x69])) // binary (NUL)
  await writeFile(join(dir, 'big.txt'), 'x'.repeat(600 * 1024)) // over MAX_DIFF_BYTES
  await writeFile(join(dir, 'přílöha.txt'), 'diakritika\n') // non-ASCII path (core.quotePath)
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'pr changes'])
  const source = await git(dir, ['rev-parse', 'HEAD'])

  return { dir, target, source }
}

/**
 * Every record shape `git diff --numstat -M -z` was observed to emit, each transcribed from a real
 * run. `-z` frames a rename as an empty path slot followed by the old and the new path, so the key
 * the counts are filed under is a path git printed rather than one this code assembled - the
 * difference between a merge that holds for every rename and one that holds for the shapes someone
 * thought to try.
 */
describe('parseNumstat', () => {
  test.each([
    ['a plain modification', '2\t1\tmodify.txt\0', '/modify.txt', 2, 1],
    ['an addition', '2\t0\tadded.txt\0', '/added.txt', 2, 0],
    ['a deletion', '0\t2\tdelete.txt\0', '/delete.txt', 0, 2],
    ['a rename with no shared segments', '0\t0\t\0oldname.txt\0brandnew.txt\0', '/brandnew.txt', 0, 0],
    [
      'a rename sharing a prefix',
      '0\t0\t\0pkg/a/mod.txt\0pkg/b/mod.txt\0',
      '/pkg/b/mod.txt',
      0,
      0
    ],
    [
      'a rename sharing a prefix and a suffix',
      '0\t0\t\0a/b/one.txt\0a/b/two.txt\0',
      '/a/b/two.txt',
      0,
      0
    ],
    [
      'a file moved up a directory level',
      '0\t0\t\0src/utils/helpers.ts\0src/helpers.ts\0',
      '/src/helpers.ts',
      0,
      0
    ],
    [
      'a file moved to the repo root',
      '0\t0\t\0deep/one/toroot.txt\0toroot.txt\0',
      '/toroot.txt',
      0,
      0
    ],
    [
      'a path with spaces',
      '0\t0\t\0sp ace old.txt\0sp ace new.txt\0',
      '/sp ace new.txt',
      0,
      0
    ],
    [
      'a non-ASCII path',
      '0\t0\t\0přílöha stará.txt\0přílöha nová.txt\0',
      '/přílöha nová.txt',
      0,
      0
    ],
    ['a rename that also changed', '2\t1\t\0old.txt\0new.txt\0', '/new.txt', 2, 1]
  ])('%s', (_name, raw, path, added, removed) => {
    expect(parseNumstat(raw)).toEqual(new Map([[path, { added, removed }]]))
  })

  test('a binary file counts as no lines at all rather than as NaN', () => {
    // git reports no line counts for a binary file, and a size summary that says NaN is worse
    // than one that leaves the file out of its arithmetic.
    expect(parseNumstat('-\t-\tassets/logo.png\0')).toEqual(
      new Map([['/assets/logo.png', { added: 0, removed: 0 }]])
    )
  })

  test('a renamed binary file is counted under its new path, still as no lines', () => {
    expect(parseNumstat('-\t-\t\0assets/logo.png\0img/logo.png\0')).toEqual(
      new Map([['/img/logo.png', { added: 0, removed: 0 }]])
    )
  })

  test('a path that itself contains an arrow is taken literally', () => {
    // The old-to-new shorthand this parser no longer reads would have found two arrows here and
    // had no way to tell which one git meant.
    expect(parseNumstat('0\t0\t\0arrow/a => b.txt\0arrow/c => d.txt\0')).toEqual(
      new Map([['/arrow/c => d.txt', { added: 0, removed: 0 }]])
    )
  })

  test('a path that itself contains braces is taken literally', () => {
    expect(parseNumstat('0\t0\t\0has {brace}/f.txt\0has {other}/f.txt\0')).toEqual(
      new Map([['/has {other}/f.txt', { added: 0, removed: 0 }]])
    )
  })

  test('a path containing a tab is not mistaken for the count fields', () => {
    expect(parseNumstat('1\t0\thas\ttab.txt\0')).toEqual(
      new Map([['/has\ttab.txt', { added: 1, removed: 0 }]])
    )
  })

  test('an empty diff produces no entries', () => {
    expect(parseNumstat('')).toEqual(new Map())
  })

  test('reads a whole multi-file stream at once', () => {
    const raw =
      '0\t0\t\0a/b/one.txt\0a/b/two.txt\0' +
      '2\t0\tadded.txt\0' +
      '-\t-\tblob.bin\0' +
      '2\t1\tmodify.txt\0' +
      '0\t0\t\0src/utils/helpers.ts\0src/helpers.ts\0'
    expect(parseNumstat(raw)).toEqual(
      new Map([
        ['/a/b/two.txt', { added: 0, removed: 0 }],
        ['/added.txt', { added: 2, removed: 0 }],
        ['/blob.bin', { added: 0, removed: 0 }],
        ['/modify.txt', { added: 2, removed: 1 }],
        ['/src/helpers.ts', { added: 0, removed: 0 }]
      ])
    )
  })
})

/**
 * `--name-status -M -z` frames each change as a status field followed by one path, or by two when
 * the status is a rename. It says nothing about line counts, and these records carry none.
 */
describe('parseNameStatus', () => {
  test('an ordinary change carries its status and no original path', () => {
    expect(parseNameStatus('M\0modify.txt\0A\0added.txt\0D\0delete.txt\0T\0link.txt\0')).toEqual([
      { path: '/modify.txt', changeType: 'edit', originalPath: null },
      { path: '/added.txt', changeType: 'add', originalPath: null },
      { path: '/delete.txt', changeType: 'delete', originalPath: null },
      { path: '/link.txt', changeType: 'edit', originalPath: null }
    ])
  })

  test('a rename carries both sides, keyed by the new one', () => {
    expect(parseNameStatus('R100\0src/utils/helpers.ts\0src/helpers.ts\0')).toEqual([
      { path: '/src/helpers.ts', changeType: 'rename', originalPath: '/src/utils/helpers.ts' }
    ])
  })

  test('a path holding a quote, a backslash or a tab arrives unmangled', () => {
    const raw = 'M\0has"quote.txt\0M\0has\\backslash.txt\0M\0has\ttab.txt\0'
    expect(parseNameStatus(raw).map((c) => c.path)).toEqual([
      '/has"quote.txt',
      '/has\\backslash.txt',
      '/has\ttab.txt'
    ])
  })

  test('an empty diff produces no records', () => {
    expect(parseNameStatus('')).toEqual([])
  })
})

describe('withCounts', () => {
  const named = [{ path: '/src/helpers.ts', changeType: 'rename' as const, originalPath: '/src/utils/helpers.ts' }]

  test('a file gets the counts filed under its path', () => {
    const counts = new Map([['/src/helpers.ts', { added: 4, removed: 2 }]])
    expect(withCounts(named, counts)).toEqual([
      {
        path: '/src/helpers.ts',
        changeType: 'rename',
        originalPath: '/src/utils/helpers.ts',
        added: 4,
        removed: 2
      }
    ])
  })

  test('a file with no counts to its name is an error, never a silent nothing-changed', () => {
    // The failure this guards against showed no error and no counts at all, so it read as an
    // ordinary file that happened to be unchanged.
    expect(() => withCounts(named, new Map())).toThrow(/\/src\/helpers\.ts/)
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

  test('every rename shape carries the counts of the file it moved', async () => {
    const changes = await localChanges(repo.dir, repo.target, repo.source)
    const byPath = new Map(changes.map((c) => [c.path, c]))

    // All four were edited on the way, so a key that did not line up would leave them at 0 / 0 -
    // exactly what a silently failed join looks like on the screen.
    expect(byPath.get('/nested/deep/new.txt')).toMatchObject({
      changeType: 'rename',
      originalPath: '/nested/deep/old.txt',
      added: 1,
      removed: 1
    })
    expect(byPath.get('/pkg/b/mod.txt')).toMatchObject({
      changeType: 'rename',
      originalPath: '/pkg/a/mod.txt',
      added: 2,
      removed: 0
    })
    expect(byPath.get('/src/helpers.ts')).toMatchObject({
      changeType: 'rename',
      originalPath: '/src/utils/helpers.ts',
      added: 1,
      removed: 0
    })
    expect(byPath.get('/toroot.txt')).toMatchObject({
      changeType: 'rename',
      originalPath: '/deep/one/toroot.txt',
      added: 1,
      removed: 1
    })
  })

  test('a path git would normally C-quote keeps its real name and its counts', async () => {
    const changes = await localChanges(repo.dir, repo.target, repo.source)
    const byPath = new Map(changes.map((c) => [c.path, c]))

    // A quoted name would not only lose the counts, it would key threads and drafts off a path no
    // other part of the pipeline knows.
    expect(byPath.get('/has"quote.txt')).toMatchObject({ changeType: 'edit', added: 1, removed: 0 })
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
