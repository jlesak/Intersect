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

  test('setLayout persists the layout and seeds slot 0 with the active tab', async () => {
    const a = await ws.create('/a')
    const t1 = ctx.tabs.create(a.id, 'shell')
    ctx.workspaces.setActiveTab(a.id, t1.id)
    const updated = await ws.setLayout(a.id, 'columns')
    expect(updated.layout).toBe('columns')
    expect(ctx.tabs.getById(t1.id)?.paneSlot).toBe(0)
  })

  test('setLayout to single clears pane slots', async () => {
    const a = await ws.create('/a')
    const t1 = ctx.tabs.create(a.id, 'shell')
    ctx.tabs.setPaneSlot(t1.id, 0)
    await ws.setLayout(a.id, 'single')
    expect(ctx.tabs.getById(t1.id)?.paneSlot).toBeNull()
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
