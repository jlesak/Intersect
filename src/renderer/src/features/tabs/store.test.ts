import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Tab, Workspace } from '@common/domain'
import { makeSessionId } from '@common/ipc'

vi.mock('./ipc')
vi.mock('@renderer/features/terminal', () => ({
  disposeSession: vi.fn(),
  disposeWorkspaceSessions: vi.fn()
}))
import * as api from './ipc'
import { disposeSession } from '@renderer/features/terminal'
import {
  getCommand,
  __resetCommandRegistryForTests
} from '@renderer/shared/registries/commandRegistry'
import { registerTabsFeature } from './register'
import { selectTabList, useTabsStore } from './store'

const mocked = vi.mocked(api)
const mockedDispose = vi.mocked(disposeSession)

const workspace = (over: Partial<Workspace> = {}): Workspace => ({
  id: 'w1',
  name: 'w1',
  folderPath: '/w1',
  layout: 'single',
  activeTabId: null,
  sortOrder: 0,
  projectId: null,
  projectSource: 'auto',
  ...over
})

const tab = (id: string, over: Partial<Tab> = {}): Tab => ({
  id,
  workspaceId: 'w1',
  title: id,
  preset: 'shell',
  paneSlot: null,
  sortOrder: 0,
  resumeSessionId: null,
  sessionStatus: null,
  suspendReason: null,
  suspendedAt: null,
  ...over
})

beforeEach(() => {
  useTabsStore.setState(
    {
      status: 'idle',
      error: null,
      workspaceId: null,
      byId: {},
      order: [],
      layout: 'single',
      activeTabId: null,
      lastPreset: 'shell',
      presetPickerOpen: false
    },
    false
  )
  vi.clearAllMocks()
})

async function hydrateWith(tabs: Tab[], ws: Workspace = workspace()) {
  mocked.workspaceState.mockResolvedValue({ workspaces: [ws], selectedWorkspaceId: ws.id })
  mocked.listByWorkspace.mockResolvedValue(tabs)
  await useTabsStore.getState().hydrate(ws.id)
}

describe('tabsStore', () => {
  test('hydrate seeds layout/activeTab from the workspace and loads its tabs', async () => {
    await hydrateWith([tab('a', { sortOrder: 0 }), tab('b', { sortOrder: 1 })], workspace({ layout: 'columns', activeTabId: 'b' }))
    const s = useTabsStore.getState()
    expect(s.status).toBe('ready')
    expect(s.workspaceId).toBe('w1')
    expect(s.layout).toBe('columns')
    expect(s.activeTabId).toBe('b')
    expect(selectTabList(s).map((t) => t.id)).toEqual(['a', 'b'])
  })

  test('createTab appends the tab and makes it active', async () => {
    await hydrateWith([])
    mocked.create.mockResolvedValue(tab('a'))
    await useTabsStore.getState().createTab('shell')
    const s = useTabsStore.getState()
    expect(selectTabList(s).map((t) => t.id)).toEqual(['a'])
    expect(s.activeTabId).toBe('a')
  })

  test('removeTab drops the tab, reselects a sibling, and disposes the terminal', async () => {
    await hydrateWith([tab('a'), tab('b')], workspace({ activeTabId: 'b' }))
    mocked.remove.mockResolvedValue(undefined)
    await useTabsStore.getState().removeTab('b')
    const s = useTabsStore.getState()
    expect(s.order).toEqual(['a'])
    expect(s.activeTabId).toBe('a')
    expect(mockedDispose).toHaveBeenCalledWith(makeSessionId('w1', 'b'))
  })

  test('removeTab of the last tab clears the active tab', async () => {
    await hydrateWith([tab('a')], workspace({ activeTabId: 'a' }))
    mocked.remove.mockResolvedValue(undefined)
    await useTabsStore.getState().removeTab('a')
    expect(useTabsStore.getState().activeTabId).toBeNull()
  })

  test('reorderTabs updates the order from the canonical rows', async () => {
    await hydrateWith([tab('a', { sortOrder: 0 }), tab('b', { sortOrder: 1 })])
    mocked.reorder.mockResolvedValue([tab('b', { sortOrder: 0 }), tab('a', { sortOrder: 1 })])
    await useTabsStore.getState().reorderTabs(['b', 'a'])
    expect(useTabsStore.getState().order).toEqual(['b', 'a'])
  })

  test('setActiveTab persists and updates the active tab', async () => {
    await hydrateWith([tab('a'), tab('b')])
    mocked.setActive.mockResolvedValue(undefined)
    await useTabsStore.getState().setActiveTab('b')
    expect(mocked.setActive).toHaveBeenCalledWith('w1', 'b')
    expect(useTabsStore.getState().activeTabId).toBe('b')
  })

  test('setLayout updates layout and reconciles pane slots locally (seeds slot 0 with active)', async () => {
    await hydrateWith([tab('a'), tab('b')], workspace({ activeTabId: 'a' }))
    mocked.setLayout.mockResolvedValue(workspace({ layout: 'columns', activeTabId: 'a' }))
    await useTabsStore.getState().setLayout('columns')
    const s = useTabsStore.getState()
    expect(s.layout).toBe('columns')
    expect(s.byId.a.paneSlot).toBe(0)
    expect(s.byId.b.paneSlot).toBeNull()
  })

  test('setLayout to single clears all pane slots', async () => {
    await hydrateWith([tab('a', { paneSlot: 0 }), tab('b', { paneSlot: 1 })], workspace({ layout: 'columns' }))
    mocked.setLayout.mockResolvedValue(workspace({ layout: 'single' }))
    await useTabsStore.getState().setLayout('single')
    const s = useTabsStore.getState()
    expect(s.byId.a.paneSlot).toBeNull()
    expect(s.byId.b.paneSlot).toBeNull()
  })

  test('assignToPane places a tab in a slot and evicts the previous occupant locally', async () => {
    await hydrateWith([tab('a', { paneSlot: 0 }), tab('b')], workspace({ layout: 'columns' }))
    mocked.assignToPane.mockImplementation(async (id, slot) => tab(id, { paneSlot: slot }))
    await useTabsStore.getState().assignToPane('b', 0)
    const s = useTabsStore.getState()
    expect(s.byId.b.paneSlot).toBe(0)
    expect(s.byId.a.paneSlot).toBeNull()
    // Eviction of the old occupant is enforced atomically in main, so only one IPC call is made.
    expect(mocked.assignToPane).toHaveBeenCalledTimes(1)
    expect(mocked.assignToPane).toHaveBeenCalledWith('b', 0)
  })

  test('clear resets to an empty, idle view', async () => {
    await hydrateWith([tab('a')])
    useTabsStore.getState().clear()
    const s = useTabsStore.getState()
    expect(s.workspaceId).toBeNull()
    expect(s.order).toEqual([])
    expect(s.status).toBe('idle')
  })
})

describe('lastPreset', () => {
  test('creating a tab makes its preset the one a bare new-tab repeats', async () => {
    await hydrateWith([])
    mocked.create.mockResolvedValue(tab('a', { preset: 'claude' }))
    await useTabsStore.getState().createTab('claude')
    expect(useTabsStore.getState().lastPreset).toBe('claude')
  })

  test('a failed create leaves the remembered preset alone', async () => {
    await hydrateWith([])
    mocked.create.mockRejectedValue(new Error('no pty'))
    await useTabsStore.getState().createTab('claude')
    expect(useTabsStore.getState().lastPreset).toBe('shell')
  })

  // The remembered preset is a user habit, not workspace data - switching workspace must not
  // silently send the next Cmd+T back to a shell.
  test('switching workspace keeps the remembered preset', async () => {
    await hydrateWith([])
    mocked.create.mockResolvedValue(tab('a', { preset: 'claude' }))
    await useTabsStore.getState().createTab('claude')
    await hydrateWith([], workspace({ id: 'w2' }))
    expect(useTabsStore.getState().lastPreset).toBe('claude')
  })

  test('switching workspace closes the preset popover', async () => {
    useTabsStore.getState().setPresetPickerOpen(true)
    await hydrateWith([])
    expect(useTabsStore.getState().presetPickerOpen).toBe(false)
  })
})

describe('keyboard tab navigation', () => {
  test('nextTab walks the bar order and wraps past the end', async () => {
    await hydrateWith([tab('a'), tab('b'), tab('c')], workspace({ activeTabId: 'a' }))
    mocked.setActive.mockResolvedValue(undefined)
    await useTabsStore.getState().nextTab()
    expect(useTabsStore.getState().activeTabId).toBe('b')
    await useTabsStore.getState().nextTab()
    expect(useTabsStore.getState().activeTabId).toBe('c')
    await useTabsStore.getState().nextTab()
    expect(useTabsStore.getState().activeTabId).toBe('a')
  })

  test('nextTab does nothing with fewer than two tabs', async () => {
    await hydrateWith([tab('a')], workspace({ activeTabId: 'a' }))
    await useTabsStore.getState().nextTab()
    expect(mocked.setActive).not.toHaveBeenCalled()
    expect(useTabsStore.getState().activeTabId).toBe('a')
  })

  test('jumpToTab selects the tab at that 1-based position', async () => {
    await hydrateWith([tab('a'), tab('b'), tab('c')])
    mocked.setActive.mockResolvedValue(undefined)
    await useTabsStore.getState().jumpToTab(2)
    expect(useTabsStore.getState().activeTabId).toBe('b')
  })

  // Nine fixed accelerators against a variable tab count: the high ones must land somewhere
  // useful rather than doing nothing.
  test('jumpToTab past the last tab lands on the last tab', async () => {
    await hydrateWith([tab('a'), tab('b'), tab('c')])
    mocked.setActive.mockResolvedValue(undefined)
    await useTabsStore.getState().jumpToTab(9)
    expect(useTabsStore.getState().activeTabId).toBe('c')
  })

  test('jumpToTab does nothing when the workspace has no tabs', async () => {
    await hydrateWith([])
    await useTabsStore.getState().jumpToTab(1)
    expect(mocked.setActive).not.toHaveBeenCalled()
    expect(useTabsStore.getState().activeTabId).toBeNull()
  })
})

describe('tabs commands', () => {
  beforeEach(() => {
    __resetCommandRegistryForTests()
    registerTabsFeature()
  })

  test('a bare new tab repeats the last preset used', async () => {
    await hydrateWith([])
    mocked.create.mockResolvedValue(tab('a', { preset: 'claude' }))
    await useTabsStore.getState().createTab('claude')
    mocked.create.mockClear()

    await getCommand('tabs.new')?.handler()
    expect(mocked.create).toHaveBeenCalledWith('w1', 'claude', undefined, undefined)
  })

  test('asking for a preset opens the picker popover', async () => {
    await hydrateWith([])
    await getCommand('tabs.newWithPreset')?.handler()
    expect(useTabsStore.getState().presetPickerOpen).toBe(true)
  })

  // Both openers need somewhere to put the tab. Fired from an accelerator there is no button to
  // grey out, so they must decline rather than look broken - and must not leave the popover armed
  // to appear later, once a tab bar is finally on screen.
  test('both new-tab commands decline when no workspace is selected', async () => {
    expect(useTabsStore.getState().workspaceId).toBeNull()

    await getCommand('tabs.new')?.handler()
    expect(mocked.create).not.toHaveBeenCalled()

    await getCommand('tabs.newWithPreset')?.handler()
    expect(useTabsStore.getState().presetPickerOpen).toBe(false)
  })

  // The File menu item stays enabled whatever the tab count, so the handler itself has to
  // tolerate being fired with nothing open.
  test('closing a tab with none open does nothing', async () => {
    await hydrateWith([])
    await getCommand('tabs.close')?.handler()
    expect(mocked.remove).not.toHaveBeenCalled()
  })

  test('closing a tab removes the active one', async () => {
    await hydrateWith([tab('a'), tab('b')], workspace({ activeTabId: 'b' }))
    mocked.remove.mockResolvedValue(undefined)
    await getCommand('tabs.close')?.handler()
    expect(mocked.remove).toHaveBeenCalledWith('b')
  })

  test('the nine positional jumps are all registered', () => {
    for (let n = 1; n <= 9; n++) {
      expect(getCommand(`tabs.jump.${n}`)?.title).toBe(`Tab ${n}`)
    }
  })
})
