import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { Project } from '@common/domain'
import { createGitMenuService, createRepoQueue, runGit } from './gitMenu'

const roots: string[] = []
function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'intersect-git-menu-'))
  roots.push(root)
  const bare = join(root, 'origin.git')
  const main = join(root, 'main')
  git(root, 'init', '--bare', bare)
  git(root, 'init', '-b', 'main', main)
  git(main, 'config', 'user.name', 'Test')
  git(main, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(main, 'tracked'), 'one\n')
  git(main, 'add', '-A')
  git(main, 'commit', '-m', 'initial')
  git(main, 'remote', 'add', 'origin', bare)
  git(main, 'push', '-u', 'origin', 'main')
  const project: Project = {
    id: 'p', name: 'Project', sortOrder: 0, archived: false, repoPaths: [main],
    jiraJql: null, jiraBoardUrl: null, adoRepositories: []
  }
  const service = createGitMenuService(() => project, createRepoQueue())
  return { root, bare, main, service, project }
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('project Git menu with real repositories', () => {
  test('commits all changes, including untracked, when nothing is staged', async () => {
    const { main, service } = fixture()
    writeFileSync(join(main, 'tracked'), 'two\n')
    writeFileSync(join(main, 'new'), 'new\n')
    const preview = await service.preview('p', main)
    expect(preview.mode).toBe('all')
    expect(preview.files.map((f) => f.path).sort()).toEqual(['new', 'tracked'])
    expect(await service.commit('p', main, preview.token, 'all changes', false)).toMatchObject({ outcome: 'committed' })
    expect(git(main, 'status', '--porcelain')).toBe('')
    expect(git(main, 'show', '--format=', '--name-only', 'HEAD').split('\n')).toEqual(['new', 'tracked'])
  })

  test('staged-only preview never becomes an all-changes commit after index changes', async () => {
    const { main, service } = fixture()
    writeFileSync(join(main, 'tracked'), 'two\n')
    writeFileSync(join(main, 'new'), 'new\n')
    git(main, 'add', 'tracked')
    const preview = await service.preview('p', main)
    expect(preview.mode).toBe('staged')
    git(main, 'reset', 'tracked')
    const result = await service.commit('p', main, preview.token, 'guard', false)
    expect(result.outcome).toBe('preview-changed')
    expect(git(main, 'log', '-1', '--format=%s')).toBe('initial')
    git(main, 'add', 'tracked')
    const staged = await service.preview('p', main)
    expect(await service.commit('p', main, staged.token, 'only staged', false)).toMatchObject({ outcome: 'committed' })
    expect(git(main, 'show', '--format=', '--name-only', 'HEAD')).toBe('tracked')
    expect(git(main, 'status', '--porcelain')).toContain('?? new')
  })

  test('hook failure preserves index and returns refreshed preview', async () => {
    const { main, service } = fixture()
    writeFileSync(join(main, 'new'), 'new\n')
    const hooks = join(main, '.git', 'hooks')
    mkdirSync(hooks, { recursive: true })
    const hook = join(hooks, 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho hook refused >&2\nexit 1\n', { mode: 0o755 })
    const before = await service.preview('p', main)
    const result = await service.commit('p', main, before.token, 'message', false)
    expect(result).toMatchObject({ outcome: 'failed' })
    if (result.outcome !== 'failed') throw new Error('Expected failure')
    expect(result.error).toContain('hook refused')
    expect(result.preview.mode).toBe('staged')
    expect(git(main, 'log', '-1', '--format=%s')).toBe('initial')
  })

  test('commit-msg hook failure preserves the message path and does not create a commit', async () => {
    const { main, service } = fixture()
    writeFileSync(join(main, 'new'), 'new\n')
    writeFileSync(join(main, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\necho message refused >&2\nexit 1\n', { mode: 0o755 })
    const before = await service.preview('p', main)
    const result = await service.commit('p', main, before.token, 'message', false)
    expect(result).toMatchObject({ outcome: 'failed' })
    if (result.outcome !== 'failed') throw new Error('Expected failure')
    expect(result.error).toContain('message refused')
    expect(git(main, 'log', '-1', '--format=%s')).toBe('initial')
  })

  test('no-upstream push works at zero ahead and commit plus failed push advances once', async () => {
    const { main, bare, service, project } = fixture()
    await service.action('p', main, { kind: 'new-branch', name: 'feature/test', start: 'HEAD' })
    expect((await service.statuses(project))[0].upstream).toBeNull()
    await service.action('p', main, { kind: 'push' })
    expect(git(main, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feature/test')
    writeFileSync(join(main, 'new'), 'new\n')
    const preview = await service.preview('p', main)
    git(bare, 'config', 'receive.denyNonFastforwards', 'true')
    // A reject hook gives the failure without changing the local commit.
    writeFileSync(join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho remote rejected >&2\nexit 1\n', { mode: 0o755 })
    const result = await service.commit('p', main, preview.token, 'one commit', true)
    expect(result.outcome).toBe('committed-push-failed')
    expect(git(main, 'log', '-1', '--format=%s')).toBe('one commit')
    expect(git(bare, 'rev-parse', 'refs/heads/feature/test')).not.toBe(git(main, 'rev-parse', 'HEAD'))
  })

  test('first Push sets tracking when an equal origin branch already exists', async () => {
    const { main, service } = fixture()
    git(main, 'push', 'origin', 'main:refs/heads/feature/existing')
    await service.action('p', main, { kind: 'new-branch', name: 'feature/existing', start: 'HEAD' })
    const result = await service.action('p', main, { kind: 'push' })
    expect(result).toContain('set upstream')
    expect(git(main, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feature/existing')
  })

  test('new branch from remote has no upstream, remote-only switch tracks', async () => {
    const { root, main, bare, service, project } = fixture()
    await service.action('p', main, { kind: 'new-branch', name: 'feature/new', start: 'origin/main' })
    expect(git(main, 'branch', '--show-current')).toBe('feature/new')
    expect((await service.statuses(project))[0].upstream).toBeNull()
    git(main, 'switch', 'main')
    const other = join(root, 'other')
    git(root, 'clone', bare, other)
    git(other, 'config', 'user.name', 'Test')
    git(other, 'config', 'user.email', 'test@example.com')
    git(other, 'switch', '-c', 'remote-only')
    git(other, 'push', '-u', 'origin', 'remote-only')
    await service.action('p', main, { kind: 'fetch' })
    expect((await service.branches('p', main)).some((b) => b.name === 'origin/remote-only' && b.kind === 'remote')).toBe(true)
    await service.action('p', main, { kind: 'switch', branch: 'origin/remote-only', remote: true })
    expect(git(main, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/remote-only')
  })

  test('branch choices identify the origin default branch even when it is local too', async () => {
    const { main, bare, service } = fixture()
    git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    git(main, 'remote', 'set-head', 'origin', '-a')
    const branches = await service.branches('p', main)
    expect(branches[0]).toMatchObject({ name: 'main', kind: 'local', current: true, defaultRemote: true })
  })

  test('New branch discovers origin HEAD when no local origin/HEAD exists', async () => {
    const { main, bare, service } = fixture()
    git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    expect((await service.branches('p', main)).some((branch) => branch.defaultRemote)).toBe(false)
    expect((await service.branches('p', main, true))[0]).toMatchObject({
      name: 'main', defaultRemote: true
    })
  })

  test('invalid and existing names reject; dirty conflicting switch keeps files and HEAD', async () => {
    const { main, service } = fixture()
    expect(await service.validateName('p', main, 'bad name')).not.toBeNull()
    expect(await service.validateName('p', main, 'main')).toContain('already exists')
    await service.action('p', main, { kind: 'new-branch', name: 'other', start: 'HEAD' })
    writeFileSync(join(main, 'tracked'), 'other branch\n')
    git(main, 'add', '-A')
    git(main, 'commit', '-m', 'other branch change')
    git(main, 'switch', 'main')
    writeFileSync(join(main, 'tracked'), 'local dirty\n')
    const before = git(main, 'rev-parse', 'HEAD')
    await expect(service.action('p', main, { kind: 'switch', branch: 'other', remote: false }))
      .rejects.toThrow('tracked')
    expect(git(main, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(main, 'branch', '--show-current')).toBe('main')
    expect(git(main, 'status', '--porcelain')).toContain('tracked')
  })

  test('pull fast-forwards, then refuses divergence without changing local HEAD', async () => {
    const { root, main, bare, service } = fixture()
    const other = join(root, 'other')
    git(root, 'clone', bare, other)
    git(other, 'config', 'user.name', 'Test')
    git(other, 'config', 'user.email', 'test@example.com')
    git(other, 'switch', 'main')
    writeFileSync(join(other, 'remote'), 'remote\n')
    git(other, 'add', '-A')
    git(other, 'commit', '-m', 'remote one')
    git(other, 'push')
    await service.action('p', main, { kind: 'pull' })
    expect(git(main, 'log', '-1', '--format=%s')).toBe('remote one')
    writeFileSync(join(main, 'local'), 'local\n')
    git(main, 'add', '-A')
    git(main, 'commit', '-m', 'local only')
    writeFileSync(join(other, 'remote'), 'remote two\n')
    git(other, 'add', '-A')
    git(other, 'commit', '-m', 'remote two')
    git(other, 'push')
    const before = git(main, 'rev-parse', 'HEAD')
    await expect(service.action('p', main, { kind: 'pull' })).rejects.toThrow('Branch has diverged')
    expect(git(main, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(main, 'show', 'HEAD:local')).toBe('local')
  })

  test('a linked binding reads the main checkout and marks held branches', async () => {
    const { root, main, service, project } = fixture()
    const linked = join(root, 'linked')
    git(main, 'worktree', 'add', '-b', 'feature/held', linked)
    project.repoPaths = [linked]
    expect((await service.statuses(project))[0]).toMatchObject({ branch: 'main', mainPath: realpathSync(main) })
    const branches = await service.branches('p', linked)
    expect(branches.find((b) => b.name === 'feature/held')).toMatchObject({ inWorktree: true })
  })

  test('a missing binding reports its own error without hiding a healthy repository', async () => {
    const { root, service, project } = fixture()
    project.repoPaths.push(join(root, 'missing'))
    const statuses = await service.statuses(project)
    expect(statuses).toHaveLength(2)
    expect(statuses[0]).toMatchObject({ branch: 'main', error: null })
    expect(statuses[1].error).toBeTruthy()
  })

  test('detached HEAD is reported and Git sees terminal prompting disabled', async () => {
    const { main, service, project } = fixture()
    expect(await runGit(main, ['-c', 'alias.showprompt=!printf %s $GIT_TERMINAL_PROMPT', 'showprompt'])).toBe('0')
    git(main, 'switch', '--detach')
    const status = (await service.statuses(project))[0]
    expect(status.branch).toBeNull()
    expect(status.head).toMatch(/^[0-9a-f]{40}$/)
    await expect(service.action('p', main, { kind: 'push' })).rejects.toThrow('detached HEAD')
  })

  test('the Git runner terminates a command at its injected timeout', async () => {
    const { main } = fixture()
    const started = Date.now()
    await expect(runGit(main, ['-c', 'alias.pause=!sleep 5', 'pause'], 50)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('a credential challenge fails without waiting for a terminal prompt', async () => {
    const { main } = fixture()
    const server = createServer((_request, response) => {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' })
      response.end('Authentication required')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing test server port')
      await expect(runGit(main, ['ls-remote', `http://127.0.0.1:${address.port}/repo.git`], 5_000))
        .rejects.toThrow(/terminal prompts disabled|could not read Username/)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test.each([
    ['merge', 'MERGE_HEAD'],
    ['cherry-pick', 'CHERRY_PICK_HEAD'],
    ['revert', 'REVERT_HEAD'],
    ['rebase', 'rebase-merge'],
    ['rebase', 'rebase-apply']
  ])('%s marker blocks mutations but permits fetch', async (expected, marker) => {
    const { main, service, project } = fixture()
    const path = join(main, '.git', marker)
    if (marker.startsWith('rebase-')) mkdirSync(path)
    else writeFileSync(path, 'marker\n')
    expect((await service.statuses(project))[0].progress).toBe(expected)
    await expect(service.action('p', main, { kind: 'push' })).rejects.toThrow('Finish the Git operation')
    await expect(service.action('p', main, { kind: 'fetch' })).resolves.toContain('Fetched')
  })

  test('repository queue serializes one clone, allows another, and releases after failure', async () => {
    const a = fixture()
    const b = fixture()
    const queue = createRepoQueue()
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const order: string[] = []
    const first = queue(a.main, async () => { order.push('first'); await held; throw new Error('fail') })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const second = queue(a.main, async () => { order.push('second') })
    await queue(b.main, async () => { order.push('different') })
    expect(order).toEqual(['first', 'different'])
    release()
    await expect(first).rejects.toThrow('fail')
    await second
    expect(order).toEqual(['first', 'different', 'second'])
  })
})
