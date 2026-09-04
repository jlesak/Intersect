import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, test } from 'vitest'
import { createAppStateRepo, SELECTED_WORKSPACE_KEY, type AppStateRepo } from '../db/appStateRepo'
import { createTabRepo, type TabRepo } from '../db/tabRepo'
import { createWorkspaceRepo, type WorkspaceRepo } from '../db/workspaceRepo'
import { makeTestDb, makeTestDeps } from '../db/testkit'
import {
  createSystemCoreHandlers,
  SIDEBAR_LAYOUT_KEY,
  type SystemCoreHandlers
} from './system.ipc'
import {
  DEFAULT_SIDEBAR_LAYOUT,
  SIDEBAR_PANEL_MAX,
  SIDEBAR_PANEL_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN
} from '@common/domain'

describe('resetViewState', () => {
  let db: DatabaseSync
  let workspaces: WorkspaceRepo
  let tabs: TabRepo
  let appState: AppStateRepo
  let handlers: SystemCoreHandlers

  beforeEach(() => {
    db = makeTestDb()
    const deps = makeTestDeps()
    workspaces = createWorkspaceRepo(db, deps)
    tabs = createTabRepo(db, deps)
    appState = createAppStateRepo(db)
    handlers = createSystemCoreHandlers({ db, workspaces, tabs, appState })
  })

  /** A workspace in a four-pane grid with one tab per pane - the state a reset has to collapse. */
  function seedGridWorkspace(name: string): string {
    const ws = workspaces.create(`/repos/${name}`, name)
    workspaces.setLayout(ws.id, 'grid')
    for (const slot of [0, 1, 2, 3]) {
      tabs.create(ws.id, 'claude', undefined, null, slot)
    }
    workspaces.setActiveTab(ws.id, tabs.listByWorkspace(ws.id)[0].id)
    return ws.id
  }

  test('collapses every workspace to a single pane without losing a tab', async () => {
    const a = seedGridWorkspace('alpha')
    const b = seedGridWorkspace('beta')

    await handlers.resetViewState()

    for (const id of [a, b]) {
      expect(workspaces.getById(id)?.layout).toBe('single')
      const grouped = tabs.listByWorkspace(id)
      expect(grouped).toHaveLength(4)
      expect(grouped.map((t) => t.paneSlot)).toEqual([0, 0, 0, 0])
      // Renumbered from zero, so the one surviving group's bar order is exactly its sort order.
      expect([...grouped].map((t) => t.sortOrder).sort((x, y) => x - y)).toEqual([0, 1, 2, 3])
    }
  })

  test('clears the active tab and the remembered workspace so the next boot picks its own spot', async () => {
    const id = seedGridWorkspace('alpha')
    appState.set(SELECTED_WORKSPACE_KEY, id)

    await handlers.resetViewState()

    expect(workspaces.getById(id)?.activeTabId).toBeNull()
    expect(appState.get(SELECTED_WORKSPACE_KEY)).toBeNull()
  })

  test('drops every stored pane divider position, in every project', async () => {
    const insert = db.prepare(
      `INSERT INTO project_terminal_layouts (project_key, layout, shares, updated_at)
       VALUES (?,?,?,?)`
    )
    insert.run('project-a', 'columns', JSON.stringify([0.7, 0.3]), 1)
    insert.run('other', 'grid', JSON.stringify([0.4, 0.6, 0.5, 0.5]), 2)

    await handlers.resetViewState()

    const rows = db.prepare('SELECT COUNT(*) AS n FROM project_terminal_layouts').get() as {
      n: number
    }
    expect(rows.n).toBe(0)
  })

  test('keeps the rows a user would grieve: tabs, workspaces, projects and settings', async () => {
    const ws = workspaces.create('/repos/alpha', 'alpha')
    const tab = tabs.create(ws.id, 'claude')
    tabs.rename(tab.id, 'the important one')
    db.prepare(
      'INSERT INTO projects (id,name,sort_order,archived,created_at) VALUES (?,?,?,?,?)'
    ).run('p1', 'Alpha', 0, 0, 1)
    appState.set('settings.session', JSON.stringify({ autoResume: true }))

    await handlers.resetViewState()

    expect(workspaces.list()).toHaveLength(1)
    expect(tabs.listByWorkspace(ws.id)[0].title).toBe('the important one')
    const projects = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }
    expect(projects.n).toBe(1)
    expect(appState.get('settings.session')).toBe(JSON.stringify({ autoResume: true }))
  })

  test('a workspace holding a layout value the app does not know still collapses cleanly', async () => {
    const ws = workspaces.create('/repos/alpha', 'alpha')
    // The column has no CHECK constraint, so an older or hand-edited profile can hold anything -
    // and that unknown value is exactly the kind of thing this reset exists to get a user out of.
    db.prepare('UPDATE workspaces SET layout = ? WHERE id = ?').run('quadrants', ws.id)
    tabs.create(ws.id, 'claude', undefined, null, 3)

    await handlers.resetViewState()

    expect(workspaces.getById(ws.id)?.layout).toBe('single')
    expect(tabs.listByWorkspace(ws.id).map((t) => t.paneSlot)).toEqual([0])
  })

  test('nothing is written when the transaction fails part-way', async () => {
    const id = seedGridWorkspace('alpha')
    appState.set(SELECTED_WORKSPACE_KEY, id)
    const failing = createSystemCoreHandlers({
      db,
      workspaces,
      tabs,
      appState: {
        get: appState.get,
        set: () => {
          throw new Error('app_state is unwritable')
        }
      }
    })

    await expect(failing.resetViewState()).rejects.toThrow('app_state is unwritable')

    // The layout collapse happens before the failing write, so a non-transactional reset would
    // have left the workspace half-reset with no way to tell.
    expect(workspaces.getById(id)?.layout).toBe('grid')
    expect(tabs.listByWorkspace(id).map((t) => t.paneSlot)).toEqual([0, 1, 2, 3])
  })
})

describe('the sidebar layout', () => {
  let db: DatabaseSync
  let appState: AppStateRepo
  let handlers: SystemCoreHandlers

  beforeEach(() => {
    db = makeTestDb()
    const deps = makeTestDeps()
    appState = createAppStateRepo(db)
    handlers = createSystemCoreHandlers({
      db,
      workspaces: createWorkspaceRepo(db, deps),
      tabs: createTabRepo(db, deps),
      appState
    })
  })

  test('a profile that never dragged anything gets the defaults', async () => {
    expect(await handlers.getSidebarLayout()).toEqual(DEFAULT_SIDEBAR_LAYOUT)
  })

  test('sizes round-trip', async () => {
    await handlers.setSidebarLayout({ width: 320, railHeight: 210, usageHeight: 150 })

    expect(await handlers.getSidebarLayout()).toEqual({
      width: 320,
      railHeight: 210,
      usageHeight: 150
    })
  })

  test('null keeps meaning "size to your content" rather than becoming a number', async () => {
    await handlers.setSidebarLayout({ width: 320, railHeight: 210, usageHeight: null })

    expect((await handlers.getSidebarLayout()).usageHeight).toBeNull()
  })

  test('an out-of-range size is clamped on the way in, not stored as given', async () => {
    const stored = await handlers.setSidebarLayout({
      width: 9999,
      railHeight: 1,
      usageHeight: 99_999
    })

    expect(stored).toEqual({
      width: SIDEBAR_WIDTH_MAX,
      railHeight: SIDEBAR_PANEL_MIN,
      usageHeight: SIDEBAR_PANEL_MAX
    })
    expect(await handlers.getSidebarLayout()).toEqual(stored)
  })

  test('a corrupt or hand-edited document degrades to the defaults', async () => {
    for (const raw of ['not json', '[]', 'null', '{"width":"wide","railHeight":{}}']) {
      appState.set(SIDEBAR_LAYOUT_KEY, raw)
      expect(await handlers.getSidebarLayout()).toEqual(DEFAULT_SIDEBAR_LAYOUT)
    }
  })

  test('a stored size outside its bounds is clamped on the way out too', async () => {
    // The window that produced a size is not the window the next launch opens in.
    appState.set(SIDEBAR_LAYOUT_KEY, JSON.stringify({ width: 5, railHeight: 90_000 }))

    expect(await handlers.getSidebarLayout()).toEqual({
      width: SIDEBAR_WIDTH_MIN,
      railHeight: SIDEBAR_PANEL_MAX,
      usageHeight: null
    })
  })

  test('resetViewState puts the sidebar back, because that is view state too', async () => {
    await handlers.setSidebarLayout({ width: 600, railHeight: 400, usageHeight: 300 })

    await handlers.resetViewState()

    expect(await handlers.getSidebarLayout()).toEqual(DEFAULT_SIDEBAR_LAYOUT)
  })
})
