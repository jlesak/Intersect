import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { IpcApi } from '@common/ipc'
import { createWorkspaceHandlers } from './workspaces.ipc'
import { makeHandlerContext, type HandlerContext } from './handlerTestkit'

describe('workspace handlers', () => {
  let ctx: HandlerContext
  let ws: IpcApi['workspaces']
  const pickFolder = vi.fn<() => Promise<string | null>>()

  beforeEach(() => {
    ctx = makeHandlerContext()
    pickFolder.mockReset()
    ws = createWorkspaceHandlers({
      db: ctx.db,
      workspaces: ctx.workspaces,
      tabs: ctx.tabs,
      appState: ctx.appState,
      sessions: ctx.sessions,
      pickFolder,
      projects: ctx.projects,
      pathDeps: ctx.pathDeps
    })
  })

  test('getState returns the workspaces and the selected id', async () => {
    const a = await ws.create('/a')
    const state = await ws.getState()
    expect(state.workspaces.map((w) => w.folderPath)).toEqual(['/a'])
    expect(state.selectedWorkspaceId).toBe(a.id)
  })

  test('creating a workspace selects it', async () => {
    await ws.create('/a')
    const b = await ws.create('/b')
    expect((await ws.getState()).selectedWorkspaceId).toBe(b.id)
  })

  test('create defaults the name to the folder basename', async () => {
    expect((await ws.create('/Users/me/proj')).name).toBe('proj')
  })

  test('rename updates the name', async () => {
    const a = await ws.create('/a')
    expect((await ws.rename(a.id, 'Renamed')).name).toBe('Renamed')
  })

  test('remove kills the workspace PTYs, cascades tabs, and reselects another workspace', async () => {
    const a = await ws.create('/a')
    const b = await ws.create('/b')
    ctx.tabs.create(a.id, 'shell')
    await ws.remove(a.id)
    expect(ctx.calls.killWorkspace).toContain(a.id)
    expect(ctx.workspaces.getById(a.id)).toBeUndefined()
    expect(ctx.tabs.listByWorkspace(a.id)).toEqual([])
    expect((await ws.getState()).selectedWorkspaceId).toBe(b.id)
  })

  test('removing the only workspace clears the selection', async () => {
    const a = await ws.create('/a')
    await ws.remove(a.id)
    expect((await ws.getState()).selectedWorkspaceId).toBeNull()
  })

  test('setLayout persists the layout and returns it with the regrouped tabs', async () => {
    const a = await ws.create('/a')
    const t1 = ctx.tabs.create(a.id, 'shell')
    const { workspace, tabs } = await ws.setLayout(a.id, 'columns')
    expect(workspace.layout).toBe('columns')
    expect(ctx.workspaces.getById(a.id)?.layout).toBe('columns')
    // Growing leaves every tab where it was; the new group starts empty.
    expect(tabs.map((t) => `${t.id}@${t.paneSlot}:${t.sortOrder}`)).toEqual([`${t1.id}@0:0`])
  })

  test('setLayout merges the groups that disappear into the ones that survive', async () => {
    const a = await ws.create('/a')
    ctx.workspaces.setLayout(a.id, 'grid')
    const p0 = ctx.tabs.create(a.id, 'shell', undefined, null, 0)
    const p1 = ctx.tabs.create(a.id, 'shell', undefined, null, 1)
    const p2 = ctx.tabs.create(a.id, 'shell', undefined, null, 2)
    const p3 = ctx.tabs.create(a.id, 'shell', undefined, null, 3)

    // The left column stays left, so grid slot 2 folds in behind slot 0.
    const columns = await ws.setLayout(a.id, 'columns')
    expect(columns.tabs.map((t) => `${t.id}@${t.paneSlot}:${t.sortOrder}`)).toEqual([
      `${p0.id}@0:0`,
      `${p2.id}@0:1`,
      `${p1.id}@1:0`,
      `${p3.id}@1:1`
    ])

    // Collapsing again merges everything into the one remaining group; nothing is lost.
    const single = await ws.setLayout(a.id, 'single')
    expect(single.tabs.map((t) => `${t.id}@${t.paneSlot}:${t.sortOrder}`)).toEqual([
      `${p0.id}@0:0`,
      `${p2.id}@0:1`,
      `${p1.id}@0:2`,
      `${p3.id}@0:3`
    ])
  })

  test('setLayout reads the layout it is leaving, so a merge is positional both ways', async () => {
    const a = await ws.create('/a')
    ctx.workspaces.setLayout(a.id, 'rows')
    const top = ctx.tabs.create(a.id, 'shell', undefined, null, 0)
    const bottom = ctx.tabs.create(a.id, 'shell', undefined, null, 1)
    // Two rows growing into the grid put the bottom row in the bottom-left pane, which is slot 2.
    const { tabs } = await ws.setLayout(a.id, 'grid')
    expect(tabs.map((t) => `${t.id}@${t.paneSlot}`)).toEqual([`${top.id}@0`, `${bottom.id}@2`])
  })

  test('setLayout on an unknown workspace throws', async () => {
    await expect(ws.setLayout('ghost', 'columns')).rejects.toThrow(/not found/i)
  })

  test('setActive persists the selected workspace', async () => {
    await ws.create('/a')
    const b = await ws.create('/b')
    await ws.setActive(b.id)
    expect((await ws.getState()).selectedWorkspaceId).toBe(b.id)
  })

  test('pickFolder returns the dialog result (path or null on cancel)', async () => {
    pickFolder.mockResolvedValueOnce('/picked')
    expect(await ws.pickFolder()).toBe('/picked')
    pickFolder.mockResolvedValueOnce(null)
    expect(await ws.pickFolder()).toBeNull()
  })

  test('create resolves the project from the folder path (worktrees included)', async () => {
    const p = ctx.projects.create('SPOT', '/repos/spot')
    expect((await ws.create('/repos/spot/src')).projectId).toBe(p.id)
    expect((await ws.create('/wt/spot/feature')).projectId).toBe(p.id)
    const other = await ws.create('/elsewhere')
    expect(other.projectId).toBeNull()
    expect(other.projectSource).toBe('auto')
  })

  test('assignProject places the workspace manually and wins over inference', async () => {
    const p = ctx.projects.create('SPOT', '/repos/spot')
    const w = await ws.create('/elsewhere')
    const assigned = await ws.assignProject(w.id, p.id)
    expect(assigned.projectId).toBe(p.id)
    expect(assigned.projectSource).toBe('manual')
  })

  test('autoAssignProject re-resolves from the folder and restores automatic tracking', async () => {
    const p = ctx.projects.create('SPOT', '/repos/spot')
    const w = await ws.create('/repos/spot/src')
    await ws.assignProject(w.id, null)
    const reverted = await ws.autoAssignProject(w.id)
    expect(reverted.projectId).toBe(p.id)
    expect(reverted.projectSource).toBe('auto')
  })
})
