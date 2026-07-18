import type { IpcMain } from 'electron'
import { beforeEach, describe, expect, test } from 'vitest'
import { Channel, type IpcApi } from '@common/ipc'
import { createProjectOverrideRepo } from '../db/projectOverrideRepo'
import type { ProjectRepo } from '../db/projectRepo'
import { makeTestDeps } from '../db/testkit'
import type { WorkspaceRepo } from '../db/workspaceRepo'
import { makeHandlerContext } from './handlerTestkit'
import { createProjectHandlers, registerProjectHandlers } from './projects.ipc'

function makeHandlers(): {
  projects: ProjectRepo
  workspaces: WorkspaceRepo
  h: IpcApi['projects']
} {
  const ctx = makeHandlerContext()
  const h = createProjectHandlers({
    projects: ctx.projects,
    pathDeps: ctx.pathDeps,
    workspaces: ctx.workspaces,
    overrides: createProjectOverrideRepo(ctx.db, makeTestDeps())
  })
  return { projects: ctx.projects, workspaces: ctx.workspaces, h }
}

describe('project handlers', () => {
  let h: IpcApi['projects']

  beforeEach(() => {
    h = makeHandlers().h
  })

  test('full CRUD and binding management round-trips through the handlers', async () => {
    const created = await h.create('SPOT', '/repos/spot')
    expect(created.repoPaths).toEqual(['/repos/spot'])

    const updated = await h.update(created.id, {
      jiraJql: 'project = FID2507',
      adoRepositories: ['spot-backend']
    })
    expect(updated.jiraJql).toBe('project = FID2507')
    expect(updated.adoRepositories).toEqual(['spot-backend'])

    const withPath = await h.addRepoPath(created.id, '/repos/spot-backend')
    expect(withPath.repoPaths).toEqual(['/repos/spot', '/repos/spot-backend'])
    const withoutPath = await h.removeRepoPath(created.id, '/repos/spot-backend')
    expect(withoutPath.repoPaths).toEqual(['/repos/spot'])

    const archived = await h.setArchived(created.id, true)
    expect(archived.archived).toBe(true)

    const second = await h.create('Two', '/repos/two')
    const reordered = await h.reorder([second.id, created.id])
    expect(reordered.map((p) => p.id)).toEqual([second.id, created.id])

    await h.remove(second.id)
    expect((await h.list()).map((p) => p.id)).toEqual([created.id])
  })

  test('resolvePath answers with the owning project or null for Other', async () => {
    const p = await h.create('SPOT', '/repos/spot')
    expect(await h.resolvePath('/repos/spot/src')).toBe(p.id)
    expect(await h.resolvePath('/wt/spot/deep')).toBe(p.id)
    expect(await h.resolvePath('/elsewhere')).toBeNull()
  })

  test('repo failures surface as message-only Errors', async () => {
    await h.create('SPOT', '/repos/spot')
    await expect(h.create('Dup', '/repos/spot')).rejects.toThrow(
      'already bound to project "SPOT"'
    )
    await expect(h.update('missing', { name: 'X' })).rejects.toThrow('Project not found')
  })

  test('binding changes re-resolve auto-assigned workspaces but never manual ones', async () => {
    const made = makeHandlers()
    const auto = made.workspaces.create('/repos/spot/src')
    const manual = made.workspaces.create('/repos/spot/tools')

    const p = await made.h.create('SPOT', '/repos/spot')
    expect(made.workspaces.getById(auto.id)?.projectId).toBe(p.id)

    made.workspaces.setProject(manual.id, null, 'manual')
    await made.h.remove(p.id)
    expect(made.workspaces.getById(auto.id)?.projectId).toBeNull()
    expect(made.workspaces.getById(manual.id)?.projectSource).toBe('manual')
  })

  test('archiving a project releases its auto-assigned workspaces to Other', async () => {
    const made = makeHandlers()
    const p = await made.h.create('SPOT', '/repos/spot')
    const w = made.workspaces.create('/repos/spot/src', undefined, p.id)
    await made.h.setArchived(p.id, true)
    expect(made.workspaces.getById(w.id)?.projectId).toBeNull()
  })

  test('overrides round-trip: set wins, clear falls back, project delete cascades', async () => {
    const made = makeHandlers()
    const p = await made.h.create('SPOT', '/repos/spot')

    await made.h.setOverride('pr', 'repo1:42', p.id)
    await made.h.setOverride('jira', 'FID2507-1', null)
    expect(await made.h.listOverrides()).toEqual([
      { kind: 'pr', key: 'repo1:42', projectId: p.id },
      { kind: 'jira', key: 'FID2507-1', projectId: null }
    ])

    await made.h.clearOverride('jira', 'FID2507-1')
    expect((await made.h.listOverrides()).map((o) => o.key)).toEqual(['repo1:42'])

    await made.h.remove(p.id)
    expect(await made.h.listOverrides()).toEqual([])
  })

  test('listWorktrees rejects for an unknown project', async () => {
    await expect(h.listWorktrees('missing')).rejects.toThrow('Project not found')
  })
})

describe('registerProjectHandlers', () => {
  type Listener = (event: unknown, ...args: unknown[]) => unknown
  let listeners: Map<string, Listener>
  let h: IpcApi['projects']

  beforeEach(() => {
    listeners = new Map()
    h = makeHandlers().h
    const fakeIpcMain = {
      handle: (channel: string, listener: Listener) => {
        listeners.set(channel, listener)
      }
    } as unknown as IpcMain
    registerProjectHandlers(fakeIpcMain, h)
  })

  test('registers exactly the project channels', () => {
    expect([...listeners.keys()].sort()).toEqual(
      [
        Channel.projectsList,
        Channel.projectsCreate,
        Channel.projectsUpdate,
        Channel.projectsSetArchived,
        Channel.projectsReorder,
        Channel.projectsRemove,
        Channel.projectsAddRepoPath,
        Channel.projectsRemoveRepoPath,
        Channel.projectsResolvePath,
        Channel.projectsListOverrides,
        Channel.projectsSetOverride,
        Channel.projectsClearOverride,
        Channel.projectsListWorktrees
      ].sort()
    )
  })

  test('listeners unwrap ipc args and delegate', async () => {
    const created = (await listeners.get(Channel.projectsCreate)!({}, 'SPOT', '/repos/spot')) as {
      id: string
    }
    const list = (await listeners.get(Channel.projectsList)!({})) as unknown[]
    expect(list).toHaveLength(1)
    const updated = (await listeners.get(Channel.projectsUpdate)!({}, created.id, {
      name: 'SPOT 2'
    })) as { name: string }
    expect(updated.name).toBe('SPOT 2')
    expect(await listeners.get(Channel.projectsResolvePath)!({}, '/repos/spot/x')).toBe(created.id)
  })
})
