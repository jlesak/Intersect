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
      sessions: ctx.sessions
    })
    wsId = ctx.workspaces.create('/a').id
  })

  test('create sets the new tab as the workspace active tab', async () => {
    const t = await tabs.create(wsId, 'shell')
    expect(ctx.workspaces.getById(wsId)?.activeTabId).toBe(t.id)
  })

  test('remove kills the PTY for that session and deletes the tab', async () => {
    const t = await tabs.create(wsId, 'shell')
    await tabs.remove(t.id)
    expect(ctx.calls.kill).toContain(makeSessionId(wsId, t.id))
    expect(ctx.tabs.getById(t.id)).toBeUndefined()
  })

  test('removing the active tab reselects a sibling in the same transaction', async () => {
    const a = await tabs.create(wsId, 'shell')
    const b = await tabs.create(wsId, 'shell') // active is now b
    await tabs.remove(b.id)
    expect(ctx.workspaces.getById(wsId)?.activeTabId).toBe(a.id)
  })

  test('removing a non-active tab leaves the active tab unchanged', async () => {
    const a = await tabs.create(wsId, 'shell')
    const b = await tabs.create(wsId, 'shell') // active is b
    await tabs.remove(a.id)
    expect(ctx.workspaces.getById(wsId)?.activeTabId).toBe(b.id)
  })

  test('removing the last tab sets the active tab to null', async () => {
    const a = await tabs.create(wsId, 'shell')
    await tabs.remove(a.id)
    expect(ctx.workspaces.getById(wsId)?.activeTabId).toBeNull()
  })

  test('reorder returns the tabs in the new order', async () => {
    const a = await tabs.create(wsId, 'shell')
    const b = await tabs.create(wsId, 'shell')
    const out = await tabs.reorder(wsId, [b.id, a.id])
    expect(out.map((t) => t.id)).toEqual([b.id, a.id])
  })

  test('assignToPane sets a pane slot', async () => {
    const a = await tabs.create(wsId, 'shell')
    expect((await tabs.assignToPane(a.id, 1)).paneSlot).toBe(1)
  })

  test('setActive updates the workspace active tab', async () => {
    const a = await tabs.create(wsId, 'shell')
    await tabs.create(wsId, 'shell')
    await tabs.setActive(wsId, a.id)
    expect(ctx.workspaces.getById(wsId)?.activeTabId).toBe(a.id)
  })
})
