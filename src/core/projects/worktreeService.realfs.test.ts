import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { makeHandlerContext } from '../api/handlerTestkit'
import { git as realGit } from '../prInbox/git'
import { createWorktreeManager } from '../prInbox/worktreeManager'
import { createRepoQueue } from './gitMenu'
import { createProjectWorktreeService, createWorktreeGuard, snapshotOf } from './worktreeService'

const exec = promisify(execFile)
const roots: string[] = []
async function command(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', cwd, ...args])).stdout.trim()
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'intersect-worktrees-')))
  roots.push(root)
  const repo = join(root, 'repo')
  const origin = join(root, 'origin.git')
  await mkdir(repo)
  await exec('git', ['init', '--bare', origin])
  await command(repo, 'init', '-b', 'main')
  await command(repo, 'config', 'user.name', 'Test')
  await command(repo, 'config', 'user.email', 'test@example.com')
  await writeFile(join(repo, '.gitignore'), 'node_modules\n')
  await command(repo, 'add', '.gitignore')
  await command(repo, 'commit', '-m', 'initial')
  await command(repo, 'remote', 'add', 'origin', origin)
  await command(repo, 'push', '-u', 'origin', 'main')
  const ctx = makeHandlerContext()
  const project = ctx.projects.create('Test', repo)
  const service = createProjectWorktreeService({
    projects: ctx.projects, workspaces: ctx.workspaces, tabs: ctx.tabs,
    appState: ctx.appState, sessions: ctx.sessions, userDataDir: join(root, 'profile'),
    onRepo: async (_path, job) => job(), guard: createWorktreeGuard()
  })
  const queuedService = (onRepo: ReturnType<typeof createRepoQueue>) =>
    createProjectWorktreeService({
      projects: ctx.projects, workspaces: ctx.workspaces, tabs: ctx.tabs,
      appState: ctx.appState, sessions: ctx.sessions, userDataDir: join(root, 'profile'),
      onRepo, guard: createWorktreeGuard()
    })
  const add = async (name: string, branch = name): Promise<string> => {
    const path = join(root, name)
    await command(repo, 'worktree', 'add', '-b', branch, path)
    await command(path, 'config', 'user.name', 'Test')
    await command(path, 'config', 'user.email', 'test@example.com')
    return path
  }
  const list = async (path: string) => {
    const group = (await service.list(project.id))[0]
    expect(group.error).toBeNull()
    return group.worktrees.find((wt) => wt.path === path)!
  }
  const request = async (path: string, options: { discardChanges?: boolean; overrideLock?: boolean; deleteBranch?: boolean } = {}) => ({
    projectId: project.id, repoPath: repo, path, snapshot: snapshotOf(await list(path)),
    discardChanges: options.discardChanges ?? false,
    overrideLock: options.overrideLock ?? false,
    deleteBranch: options.deleteBranch ?? false
  })
  return { root, repo, project, ctx, service, queuedService, add, list, request }
}

async function holdRepositoryQueue(repo: string) {
  const queue = createRepoQueue()
  let entered: () => void = () => {}
  let release: () => void = () => {}
  const started = new Promise<void>((resolve) => { entered = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  const pending = queue(repo, async () => { entered(); await held })
  await started
  return { queue, release, pending }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('project worktree deletion with real Git', () => {
  test('clean deletion removes the folder and registration, with optional branch deletion', async () => {
    const f = await fixture()
    const first = await f.add('first')
    expect((await f.service.delete(await f.request(first))).outcome).toBe('deleted')
    expect(existsSync(first)).toBe(false)
    expect(await command(f.repo, 'branch', '--list', 'first')).toContain('first')
    const second = await f.add('second')
    const result = await f.service.delete(await f.request(second, { deleteBranch: true }))
    expect(result).toMatchObject({ outcome: 'deleted', branchDeleted: true })
    expect(await command(f.repo, 'branch', '--list', 'second')).toBe('')
  })

  test('exact dirty snapshot refuses added files even when discard was confirmed', async () => {
    const f = await fixture()
    const path = await f.add('dirty')
    await writeFile(join(path, 'a.txt'), 'a')
    const request = await f.request(path, { discardChanges: true })
    expect(request.snapshot.changed).toEqual([{ code: '??', path: 'a.txt' }])
    await writeFile(join(path, 'b.txt'), 'b')
    expect(await f.service.delete(request)).toMatchObject({ outcome: 'changed' })
    expect(existsSync(path)).toBe(true)
    expect((await f.service.delete(await f.request(path))).outcome).toBe('changed')
    expect((await f.service.delete(await f.request(path, { discardChanges: true }))).outcome).toBe('deleted')
  })

  test('ignored files do not make a worktree dirty', async () => {
    const f = await fixture()
    const path = await f.add('ignored')
    await mkdir(join(path, 'node_modules'))
    await writeFile(join(path, 'node_modules', 'cache'), 'ignored')
    expect((await f.list(path)).changed).toEqual([])
    expect((await f.service.delete(await f.request(path))).outcome).toBe('deleted')
  })

  test('lock needs explicit override and missing entries remove one registration only', async () => {
    const f = await fixture()
    const locked = await f.add('locked')
    await command(f.repo, 'worktree', 'lock', '--reason', 'maintenance', locked)
    expect((await f.list(locked)).lockedReason).toBe('maintenance')
    expect((await f.service.delete(await f.request(locked))).outcome).toBe('changed')
    expect((await f.service.delete(await f.request(locked, { overrideLock: true }))).outcome).toBe('deleted')
    const a = await f.add('missing-a')
    const b = await f.add('missing-b')
    await rm(a, { recursive: true })
    await rm(b, { recursive: true })
    await f.service.removeEntry(f.project.id, f.repo, a)
    expect((await f.service.list(f.project.id))[0].worktrees.map((wt) => wt.path)).toContain(b)
    expect(await command(f.repo, 'branch', '--list', 'missing-a')).toContain('missing-a')
  })

  test('an unpushed branch tip change stops deletion even when count is unchanged', async () => {
    const f = await fixture()
    const path = await f.add('unpushed')
    await writeFile(join(path, 'work'), 'first')
    await command(path, 'add', 'work')
    await command(path, 'commit', '-m', 'first')
    const request = await f.request(path, { deleteBranch: true })
    expect(request.snapshot.unpushed).toBe(1)
    await writeFile(join(path, 'work'), 'second')
    await command(path, 'add', 'work')
    await command(path, 'commit', '--amend', '-m', 'second')
    expect((await f.service.delete(request)).outcome).toBe('changed')
    expect(existsSync(path)).toBe(true)
  })

  test('rejects main checkout and unknown paths even with a forged snapshot', async () => {
    const f = await fixture()
    const main = await f.request(f.repo)
    await expect(f.service.delete(main)).rejects.toThrow('eligible linked')
    await expect(f.service.delete({ ...main, path: join(f.root, 'forged') })).rejects.toThrow('eligible linked')
    expect(existsSync(f.repo)).toBe(true)
  })

  test('creation date follows the matching admin folder birth time, not its mtime', async () => {
    const f = await fixture()
    const older = await f.add('older')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const newer = await f.add('newer')
    const adminNames = await readdir(join(f.repo, '.git', 'worktrees'))
    const admin = join(f.repo, '.git', 'worktrees', adminNames.find((name) => name === 'older')!)
    const birth = (await stat(admin)).birthtimeMs
    await new Promise((resolve) => setTimeout(resolve, 20))
    await writeFile(join(admin, 'fixture-marker'), 'changes admin mtime')
    expect((await stat(admin)).mtimeMs).toBeGreaterThan(birth)
    expect((await f.list(older)).createdAt).toBe(birth)
    const rows = (await f.service.list(f.project.id))[0].worktrees
    expect(rows.map((row) => row.path)).toEqual([f.repo, newer, older])
    expect(rows[0].createdAt).toBeNull()
  })

  test('gone upstream, unpushed and managed states come from Git and the managed root', async () => {
    const f = await fixture()
    const gone = await f.add('gone')
    await command(gone, 'push', '-u', 'origin', 'gone')
    await command(gone, 'push', 'origin', '--delete', 'gone')
    await command(gone, 'fetch', '--prune')
    expect((await f.list(gone)).goneOnOrigin).toBe(true)
    const managed = join(f.root, 'profile', 'pr-fix-worktrees', 'one')
    await mkdir(join(f.root, 'profile', 'pr-fix-worktrees'), { recursive: true })
    await command(f.repo, 'worktree', 'add', '-b', 'managed', managed)
    expect((await f.list(managed)).managed).toBe('fix')
    await expect(f.service.delete(await f.request(managed))).rejects.toThrow('eligible linked')
    expect(existsSync(managed)).toBe(true)
  })

  test('session timeout leaves folder, branch, workspaces and tabs intact', async () => {
    const f = await fixture()
    const path = await f.add('busy')
    const ws = f.ctx.workspaces.create(path)
    const tab = f.ctx.tabs.create(ws.id, 'claude')
    f.ctx.sessions.has = () => true
    f.ctx.sessions.whenWorkspaceExited = async () => 'timeout'
    expect((await f.list(path)).workspaces).toMatchObject([
      { id: ws.id, tabs: 1, runningClaude: 1 }
    ])
    expect(await f.service.delete(await f.request(path))).toMatchObject({ outcome: 'timeout' })
    expect(f.ctx.calls.killWorkspace).toContain(ws.id)
    expect(existsSync(path)).toBe(true)
    expect(f.ctx.workspaces.getById(ws.id)).toBeDefined()
    expect(f.ctx.tabs.getById(tab.id)).toBeDefined()
    expect(await command(f.repo, 'branch', '--list', 'busy')).toContain('busy')
  })

  test('a new file during session exit stops a confirmed dirty deletion', async () => {
    const f = await fixture()
    const path = await f.add('waiting')
    const ws = f.ctx.workspaces.create(path)
    f.ctx.tabs.create(ws.id, 'claude')
    await writeFile(join(path, 'a.txt'), 'a')
    const request = await f.request(path, { discardChanges: true })
    let release: (outcome: 'exited') => void = () => {}
    const exit = new Promise<'exited'>((resolve) => { release = resolve })
    f.ctx.sessions.whenWorkspaceExited = () => exit
    const pending = f.service.delete(request)
    await vi.waitFor(() => expect(f.ctx.calls.killWorkspace).toContain(ws.id))
    await writeFile(join(path, 'b.txt'), 'b')
    release('exited')
    expect(await pending).toMatchObject({ outcome: 'changed' })
    expect(existsSync(path)).toBe(true)
    expect(f.ctx.workspaces.getById(ws.id)).toBeDefined()
  })

  test('a changed file status or newly acquired lock invalidates the dialog snapshot', async () => {
    const f = await fixture()
    const path = await f.add('changing')
    await writeFile(join(path, 'a.txt'), 'a')
    const beforeStage = await f.request(path, { discardChanges: true })
    await command(path, 'add', 'a.txt')
    expect((await f.service.delete(beforeStage)).outcome).toBe('changed')
    const beforeLock = await f.request(path, { discardChanges: true })
    await command(f.repo, 'worktree', 'lock', '--reason', 'keep', path)
    expect((await f.service.delete(beforeLock)).outcome).toBe('changed')
    expect(existsSync(path)).toBe(true)
  })

  test('branch deletion failure reports partial success and removes the orphaned workspace', async () => {
    const f = await fixture()
    const path = await f.add('branch-fails')
    const ws = f.ctx.workspaces.create(path)
    const tab = f.ctx.tabs.create(ws.id, 'shell')
    const service = createProjectWorktreeService({
      projects: f.ctx.projects, workspaces: f.ctx.workspaces, tabs: f.ctx.tabs,
      appState: f.ctx.appState, sessions: f.ctx.sessions,
      userDataDir: join(f.root, 'profile'), guard: createWorktreeGuard(),
      onRepo: async (_path, job) => job(),
      runGit: async (repo, args) => {
        if (args.includes('branch')) throw new Error('branch lock refused')
        return realGit(repo, args)
      }
    })
    expect(await service.delete(await f.request(path, { deleteBranch: true }))).toMatchObject({
      outcome: 'partial', detail: 'branch lock refused', workspaceIds: [ws.id], closedTabs: 1
    })
    expect(existsSync(path)).toBe(false)
    expect(f.ctx.workspaces.getById(ws.id)).toBeUndefined()
    expect(f.ctx.tabs.getById(tab.id)).toBeUndefined()
    expect(await command(f.repo, 'branch', '--list', 'branch-fails')).toContain('branch-fails')
  })

  test('project deletion holds PR cleanup and prune on the same repository queue', async () => {
    const f = await fixture()
    const target = await f.add('target')
    const ws = f.ctx.workspaces.create(target)
    const profile = join(f.root, 'profile')
    const fixPath = join(profile, 'pr-fix-worktrees', 'fix')
    const reviewPath = join(profile, 'pr-review-worktrees', 'review')
    await mkdir(join(profile, 'pr-fix-worktrees'), { recursive: true })
    await mkdir(join(profile, 'pr-review-worktrees'), { recursive: true })
    await command(f.repo, 'worktree', 'add', '-b', 'pr-fix', fixPath)
    await command(f.repo, 'worktree', 'add', '-b', 'pr-review', reviewPath)
    const queue = createRepoQueue()
    const manager = createWorktreeManager(profile, { onClone: queue })
    const service = createProjectWorktreeService({
      projects: f.ctx.projects, workspaces: f.ctx.workspaces, tabs: f.ctx.tabs,
      appState: f.ctx.appState, sessions: f.ctx.sessions, userDataDir: profile,
      onRepo: queue, guard: createWorktreeGuard()
    })
    let release: (outcome: 'exited') => void = () => {}
    f.ctx.sessions.whenWorkspaceExited = () => new Promise((resolve) => { release = resolve })
    const deletion = service.delete(await f.request(target))
    await vi.waitFor(() => expect(f.ctx.calls.killWorkspace).toContain(ws.id))
    const clean = manager.removeCleanWorktree(fixPath)
    const prune = manager.pruneStale([f.repo])
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(existsSync(fixPath)).toBe(true)
    expect(existsSync(reviewPath)).toBe(true)
    release('exited')
    expect((await deletion).outcome).toBe('deleted')
    expect((await clean).outcome).toBe('removed')
    await prune
    expect(existsSync(fixPath)).toBe(false)
    expect(existsSync(reviewPath)).toBe(false)
  })

  test('a linked repository binding can be deleted with its branch', async () => {
    const f = await fixture()
    const bound = await f.add('bound')
    f.ctx.projects.addRepoPath(f.project.id, bound)
    const group = (await f.service.list(f.project.id)).find((repo) => repo.repoPath === bound)!
    const wt = group.worktrees.find((entry) => entry.path === bound)!
    const result = await f.service.delete({
      projectId: f.project.id, repoPath: bound, path: bound, snapshot: snapshotOf(wt),
      discardChanges: false, overrideLock: false, deleteBranch: true
    })
    expect(result).toMatchObject({ outcome: 'deleted', branchDeleted: true })
    expect(existsSync(bound)).toBe(false)
    expect(await command(f.repo, 'branch', '--list', 'bound')).toBe('')
  })

  test('queued delete refuses a repository unbound while another Git job runs', async () => {
    const f = await fixture()
    const target = await f.add('queued-target')
    const spare = await f.add('spare-binding')
    f.ctx.projects.addRepoPath(f.project.id, spare)
    const request = await f.request(target)
    const held = await holdRepositoryQueue(f.repo)
    const pending = f.queuedService(held.queue).delete(request)
    f.ctx.projects.removeRepoPath(f.project.id, f.repo)
    held.release()
    await expect(pending).rejects.toThrow('not bound')
    await held.pending
    expect(existsSync(target)).toBe(true)
    expect(await command(spare, 'branch', '--list', 'queued-target')).toContain('queued-target')
  })

  test('queued delete refuses a project removed while another Git job runs', async () => {
    const f = await fixture()
    const target = await f.add('queued-project')
    const request = await f.request(target)
    const held = await holdRepositoryQueue(f.repo)
    const pending = f.queuedService(held.queue).delete(request)
    f.ctx.projects.remove(f.project.id)
    held.release()
    await expect(pending).rejects.toThrow('Project not found')
    await held.pending
    expect(existsSync(target)).toBe(true)
  })

  test('queued missing-entry removal refuses an unbound repository', async () => {
    const f = await fixture()
    const missing = await f.add('missing-unbound')
    const spare = await f.add('spare-binding')
    f.ctx.projects.addRepoPath(f.project.id, spare)
    await rm(missing, { recursive: true })
    const held = await holdRepositoryQueue(f.repo)
    const pending = f.queuedService(held.queue).removeEntry(f.project.id, f.repo, missing)
    f.ctx.projects.removeRepoPath(f.project.id, f.repo)
    held.release()
    await expect(pending).rejects.toThrow('not bound')
    await held.pending
    expect(await command(spare, 'worktree', 'list', '--porcelain')).toContain(missing)
  })

  test('unbind during session exit keeps the folder and branch after the wait', async () => {
    const f = await fixture()
    const target = await f.add('waiting-unbind')
    const spare = await f.add('spare-binding')
    f.ctx.projects.addRepoPath(f.project.id, spare)
    const request = await f.request(target, { deleteBranch: true })
    const ws = f.ctx.workspaces.create(target)
    let release: (outcome: 'exited') => void = () => {}
    f.ctx.sessions.whenWorkspaceExited = () => new Promise((resolve) => { release = resolve })
    const pending = f.service.delete(request)
    await vi.waitFor(() => expect(f.ctx.calls.killWorkspace).toContain(ws.id))
    f.ctx.projects.removeRepoPath(f.project.id, f.repo)
    release('exited')
    await expect(pending).rejects.toThrow('not bound')
    expect(existsSync(target)).toBe(true)
    expect(f.ctx.workspaces.getById(ws.id)).toBeDefined()
    expect(await command(spare, 'branch', '--list', 'waiting-unbind')).toContain('waiting-unbind')
  })
})
