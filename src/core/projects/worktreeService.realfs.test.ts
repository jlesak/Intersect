import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { makeHandlerContext } from '../api/handlerTestkit'
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
  return { root, repo, project, ctx, service, add, list, request }
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
})
