import { beforeEach, describe, expect, test } from 'vitest'
import { Channel, type IpcApi } from '@common/ipc'
import { createProjectOverrideRepo } from '../db/projectOverrideRepo'
import type { ProjectRepo } from '../db/projectRepo'
import { createTerminalLayoutRepo } from '../db/terminalLayoutRepo'
import { makeTestDeps } from '../db/testkit'
import type { WorkspaceRepo } from '../db/workspaceRepo'
import { makeHandlerContext } from './handlerTestkit'
import { createProjectHandlers, projectsWireRoutes } from './projects.ipc'

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
    overrides: createProjectOverrideRepo(ctx.db, makeTestDeps()),
    terminalLayouts: createTerminalLayoutRepo(ctx.db, makeTestDeps())
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

  test('terminal layouts round-trip per project key, normalizing on write', async () => {
    await h.setTerminalLayout('p1', 'columns', [70, 30])
    await h.setTerminalLayout('p1', 'grid', {
      columns: [60, 40],
      leftRows: [5, 95],
      rightRows: [20, 80]
    })
    await h.setTerminalLayout('other', 'columns', [40, 60])
    expect(await h.getTerminalLayouts('p1')).toEqual({
      columns: [70, 30],
      grid: { columns: [60, 40], leftRows: [10, 90], rightRows: [20, 80] }
    })
    expect(await h.getTerminalLayouts('other')).toEqual({ columns: [40, 60] })
    expect(await h.getTerminalLayouts('unseen')).toEqual({})
  })

  test('setTerminalLayout rejects a layout without pane shares', async () => {
    await expect(h.setTerminalLayout('p1', 'single' as never, [50, 50])).rejects.toThrow(
      'no pane shares'
    )
  })

  test('removing a project drops its terminal layouts but keeps the Other bucket', async () => {
    const p = await h.create('SPOT', '/repos/spot')
    await h.setTerminalLayout(p.id, 'columns', [70, 30])
    await h.setTerminalLayout('other', 'columns', [20, 80])
    await h.remove(p.id)
    expect(await h.getTerminalLayouts(p.id)).toEqual({})
    expect(await h.getTerminalLayouts('other')).toEqual({ columns: [20, 80] })
  })
})

describe('projectsWireRoutes', () => {
  let routes: ReturnType<typeof projectsWireRoutes>

  beforeEach(() => {
    routes = projectsWireRoutes(makeHandlers().h)
  })

  test('exposes exactly the project channels', () => {
    expect(Object.keys(routes).sort()).toEqual(
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
        Channel.projectsListWorktrees,
        Channel.projectsGetTerminalLayouts,
        Channel.projectsSetTerminalLayout
      ].sort()
    )
  })

  test('routes apply wire args and delegate to the handlers', async () => {
    const call = (channel: string, ...args: unknown[]): unknown =>
      (routes[channel] as (...a: unknown[]) => unknown)(...args)
    const created = (await call(Channel.projectsCreate, 'SPOT', '/repos/spot')) as { id: string }
    const list = (await call(Channel.projectsList)) as unknown[]
    expect(list).toHaveLength(1)
    const updated = (await call(Channel.projectsUpdate, created.id, { name: 'SPOT 2' })) as {
      name: string
    }
    expect(updated.name).toBe('SPOT 2')
    expect(await call(Channel.projectsResolvePath, '/repos/spot/x')).toBe(created.id)
  })
})
