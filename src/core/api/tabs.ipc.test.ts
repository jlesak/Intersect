import { beforeEach, describe, expect, test } from 'vitest'
import type { IpcApi } from '@common/ipc'
import { makeSessionId } from '@common/ipc'
import { createTabHandlers } from './tabs.ipc'
import { makeHandlerContext, type HandlerContext } from './handlerTestkit'

describe('tab handlers', () => {
  let ctx: HandlerContext
  let tabs: IpcApi['tabs']
  let wsId: string

  beforeEach(() => {
    ctx = makeHandlerContext()
    tabs = createTabHandlers({
      db: ctx.db,
      workspaces: ctx.workspaces,
      tabs: ctx.tabs,
      workItems: ctx.workItemRefs,
      sessions: ctx.sessions
    })
    wsId = ctx.workspaces.create('/a').id
  })

  /** The workspace's tabs as `id@slot:order`, read back from the database. */
  const placements = (): string[] =>
    ctx.tabs.listByWorkspace(wsId).map((t) => `${t.id}@${t.paneSlot}:${t.sortOrder}`)

  test('create focuses the new tab: it is stamped and the workspace points at it', async () => {
    const t = await tabs.create(wsId, 'shell', 0)
    expect(ctx.workspaces.getById(wsId)?.activeTabId).toBe(t.id)
    expect(t.lastActiveAt).not.toBeNull()
    expect(ctx.tabs.getById(t.id)?.lastActiveAt).toBe(t.lastActiveAt)
  })

  test('create appends the tab to the group it names', async () => {
    const a = await tabs.create(wsId, 'shell', 1)
    const b = await tabs.create(wsId, 'shell', 0)
    const c = await tabs.create(wsId, 'shell', 1)
    expect(placements()).toEqual([`${b.id}@0:0`, `${a.id}@1:0`, `${c.id}@1:1`])
  })

  test('a new tab is the one its pane shows, even next to a previously used tab', async () => {
    const older = await tabs.create(wsId, 'shell', 0)
    await tabs.setActive(wsId, older.id)
    const fresh = await tabs.create(wsId, 'shell', 0)
    expect(fresh.lastActiveAt).not.toBeNull()
    expect(fresh.lastActiveAt!).toBeGreaterThanOrEqual(ctx.tabs.getById(older.id)!.lastActiveAt!)
  })

  test('create persists the resume session id when one is passed', async () => {
    const t = await tabs.create(wsId, 'claude', 0, 'sess-uuid-42')
    expect(t.resumeSessionId).toBe('sess-uuid-42')
    expect(ctx.tabs.getById(t.id)?.resumeSessionId).toBe('sess-uuid-42')
    // A plain tab carries no resume id.
    expect((await tabs.create(wsId, 'shell', 0)).resumeSessionId).toBeNull()
  })

  test('create with a primary work item writes tab and ref atomically and titles the tab', async () => {
    const t = await tabs.create(wsId, 'claude', 0, null, {
      source: 'jira',
      externalKey: 'FID-7',
      projectId: null,
      snapshot: { key: 'FID-7', title: 'Fix it', type: 'issue' }
    })
    expect(t.title).toBe('FID-7')
    const ref = ctx.workItemRefs.get(t.id)
    expect(ref?.externalKey).toBe('FID-7')
    expect(ctx.workItemRefs.history(t.id).map((e) => e.action)).toEqual(['assign'])
  })

  test('a failing ref write rolls the tab creation back (nothing half-created)', async () => {
    await expect(
      tabs.create(wsId, 'claude', 0, null, {
        source: 'not-a-source' as never,
        externalKey: 'x',
        projectId: null,
        snapshot: { key: 'x', title: 'x', type: 'x' }
      })
    ).rejects.toThrow()
    expect(await tabs.listByWorkspace(wsId)).toEqual([])
    expect(ctx.workspaces.getById(wsId)?.activeTabId).toBeNull()
  })

  test('renaming a tab leaves its primary work item untouched', async () => {
    const t = await tabs.create(wsId, 'claude', 0, null, {
      source: 'jira',
      externalKey: 'FID-7',
      projectId: null,
      snapshot: { key: 'FID-7', title: 'Fix it', type: 'issue' }
    })
    await tabs.rename(t.id, 'My own name')
    expect(ctx.tabs.getById(t.id)?.title).toBe('My own name')
    expect(ctx.workItemRefs.get(t.id)?.externalKey).toBe('FID-7')
  })

  test('remove kills the PTY for that session and deletes the tab', async () => {
    const t = await tabs.create(wsId, 'shell', 0)
    await tabs.remove(t.id)
    expect(ctx.calls.kill).toContain(makeSessionId(wsId, t.id))
    expect(ctx.tabs.getById(t.id)).toBeUndefined()
  })

  test('remove closes the gap it leaves in the group', async () => {
    const a = await tabs.create(wsId, 'shell', 1)
    const b = await tabs.create(wsId, 'shell', 1)
    const c = await tabs.create(wsId, 'shell', 1)
    await tabs.remove(b.id)
    expect(placements()).toEqual([`${a.id}@1:0`, `${c.id}@1:1`])
  })

  test('removing the active tab reselects a sibling in the same transaction', async () => {
    const a = await tabs.create(wsId, 'shell', 0)
    const b = await tabs.create(wsId, 'shell', 0) // active is now b
    await tabs.remove(b.id)
    expect(ctx.workspaces.getById(wsId)?.activeTabId).toBe(a.id)
  })

  test('removing a non-active tab leaves the active tab unchanged', async () => {
    const a = await tabs.create(wsId, 'shell', 0)
    const b = await tabs.create(wsId, 'shell', 0) // active is b
    await tabs.remove(a.id)
    expect(ctx.workspaces.getById(wsId)?.activeTabId).toBe(b.id)
  })

  test('removing the last tab sets the active tab to null', async () => {
    const a = await tabs.create(wsId, 'shell', 0)
    await tabs.remove(a.id)
    expect(ctx.workspaces.getById(wsId)?.activeTabId).toBeNull()
  })

  test('moveTab drags a tab into another group and returns the whole workspace in order', async () => {
    const a = await tabs.create(wsId, 'shell', 0)
    const b = await tabs.create(wsId, 'shell', 0)
    const x = await tabs.create(wsId, 'shell', 1)
    const out = await tabs.moveTab(a.id, 1, 0)
    expect(out.map((t) => `${t.id}@${t.paneSlot}:${t.sortOrder}`)).toEqual([
      `${b.id}@0:0`,
      `${a.id}@1:0`,
      `${x.id}@1:1`
    ])
    expect(placements()).toEqual([`${b.id}@0:0`, `${a.id}@1:0`, `${x.id}@1:1`])
  })

  test('moveTab inside one group reorders it', async () => {
    const a = await tabs.create(wsId, 'shell', 0)
    const b = await tabs.create(wsId, 'shell', 0)
    await tabs.moveTab(b.id, 0, 0)
    expect(placements()).toEqual([`${b.id}@0:0`, `${a.id}@0:1`])
  })

  test('setActive updates the workspace active tab and stamps the tab it returns', async () => {
    const a = await tabs.create(wsId, 'shell', 0)
    await tabs.create(wsId, 'shell', 0)
    const activated = await tabs.setActive(wsId, a.id)
    expect(ctx.workspaces.getById(wsId)?.activeTabId).toBe(a.id)
    expect(activated.id).toBe(a.id)
    expect(activated.lastActiveAt).toBe(ctx.tabs.getById(a.id)?.lastActiveAt)
    expect(typeof activated.lastActiveAt).toBe('number')
  })

  test('setActive on a missing tab leaves the workspace untouched', async () => {
    const a = await tabs.create(wsId, 'shell', 0)
    await expect(tabs.setActive(wsId, 'ghost')).rejects.toThrow(/not found/i)
    expect(ctx.workspaces.getById(wsId)?.activeTabId).toBe(a.id)
  })
})
