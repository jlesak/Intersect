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
import {
  selectFocusedSlot,
  selectGroupTabs,
  selectGroupVisibleTab,
  selectTabList,
  useTabsStore
} from './store'

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
  paneSlot: 0,
  sortOrder: 0,
  lastActiveAt: null,
  resumeSessionId: null,
  sessionStatus: null,
  suspendReason: null,
  suspendedAt: null,
  ...over
})

/** One group's worth of tabs, numbered in bar order - the shape every group fixture needs. */
const group = (slot: number, ids: string[]): Tab[] =>
  ids.map((id, index) => tab(id, { paneSlot: slot, sortOrder: index }))

// Activation stamps have to keep rising for the visible-tab rule to have anything to compare, so
// the fake setActive hands one out the way the real one does.
let stamp = 0

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
  stamp = 1000
  mocked.setActive.mockImplementation(async (_workspaceId, tabId) => ({
    ...useTabsStore.getState().byId[tabId],
    lastActiveAt: ++stamp
  }))
})

async function hydrateWith(tabs: Tab[], ws: Workspace = workspace()) {
  mocked.workspaceState.mockResolvedValue({ workspaces: [ws], selectedWorkspaceId: ws.id })
  mocked.listByWorkspace.mockResolvedValue(tabs)
  await useTabsStore.getState().hydrate(ws.id)
}

describe('tabsStore', () => {
  test('hydrate seeds layout/activeTab and orders every tab by group then position', async () => {
    await hydrateWith(
      [
        tab('b', { paneSlot: 1, sortOrder: 0 }),
        tab('a', { paneSlot: 0, sortOrder: 1 }),
        tab('z', { paneSlot: 0, sortOrder: 0 })
      ],
      workspace({ layout: 'columns', activeTabId: 'b' })
    )
    const s = useTabsStore.getState()
    expect(s.status).toBe('ready')
    expect(s.workspaceId).toBe('w1')
    expect(s.layout).toBe('columns')
    expect(s.activeTabId).toBe('b')
    expect(selectTabList(s).map((t) => t.id)).toEqual(['z', 'a', 'b'])
  })

  test('createTab opens the tab in the focused group and shows it there', async () => {
    await hydrateWith(
      [...group(0, ['a']), ...group(1, ['b'])],
      workspace({ layout: 'columns', activeTabId: 'b' })
    )
    // Main creates, stamps and focuses in one transaction, so the tab comes back already carrying
    // the activation stamp that decides what its group shows.
    mocked.create.mockResolvedValue(tab('c', { paneSlot: 1, sortOrder: 1, lastActiveAt: ++stamp }))

    const created = await useTabsStore.getState().createTab('shell')

    expect(mocked.create).toHaveBeenCalledWith('w1', 'shell', 1, undefined, undefined)
    expect(created?.id).toBe('c')
    const s = useTabsStore.getState()
    expect(selectGroupTabs(s, 1).map((t) => t.id)).toEqual(['b', 'c'])
    expect(selectGroupTabs(s, 0).map((t) => t.id)).toEqual(['a'])
    expect(s.activeTabId).toBe('c')
    // Without the activation stamp the pane would go on showing 'b'.
    expect(selectGroupVisibleTab(s, 1)?.id).toBe('c')
  })

  test('createTab with nothing open falls to group 0', async () => {
    await hydrateWith([], workspace({ layout: 'columns' }))
    mocked.create.mockResolvedValue(tab('a'))
    await useTabsStore.getState().createTab('shell')
    expect(mocked.create).toHaveBeenCalledWith('w1', 'shell', 0, undefined, undefined)
  })

  test('removeTab hands focus to a sibling in the same group rather than another group', async () => {
    await hydrateWith(
      [...group(0, ['a']), ...group(1, ['b', 'c'])],
      workspace({ layout: 'columns', activeTabId: 'b' })
    )
    mocked.remove.mockResolvedValue(undefined)

    await useTabsStore.getState().removeTab('b')

    const s = useTabsStore.getState()
    expect(s.order).toEqual(['a', 'c'])
    expect(s.activeTabId).toBe('c')
    // Main picks the workspace's first tab when it deletes the row, which would land in group 0.
    // The renderer's group-local choice has to be persisted over it.
    expect(mocked.setActive).toHaveBeenCalledWith('w1', 'c')
    expect(mockedDispose).toHaveBeenCalledWith(makeSessionId('w1', 'b'))
  })

  test('removeTab leaves the group once closing the tab empties it', async () => {
    await hydrateWith(
      [...group(0, ['a']), ...group(1, ['b'])],
      workspace({ layout: 'columns', activeTabId: 'b' })
    )
    mocked.remove.mockResolvedValue(undefined)
    await useTabsStore.getState().removeTab('b')
    expect(useTabsStore.getState().activeTabId).toBe('a')
  })

  test('removeTab of an inactive tab leaves focus where it is', async () => {
    await hydrateWith(group(0, ['a', 'b']), workspace({ activeTabId: 'a' }))
    mocked.remove.mockResolvedValue(undefined)
    await useTabsStore.getState().removeTab('b')
    expect(useTabsStore.getState().activeTabId).toBe('a')
    expect(mocked.setActive).not.toHaveBeenCalled()
  })

  test('removeTab of the last tab clears the active tab', async () => {
    await hydrateWith([tab('a')], workspace({ activeTabId: 'a' }))
    mocked.remove.mockResolvedValue(undefined)
    await useTabsStore.getState().removeTab('a')
    expect(useTabsStore.getState().activeTabId).toBeNull()
    expect(mocked.setActive).not.toHaveBeenCalled()
  })

  test('moveTab rebuilds both groups from the canonical rows', async () => {
    await hydrateWith(
      [...group(0, ['a', 'b']), ...group(1, ['c'])],
      workspace({ layout: 'columns', activeTabId: 'b' })
    )
    mocked.moveTab.mockResolvedValue([...group(0, ['a']), ...group(1, ['c', 'b'])])

    await useTabsStore.getState().moveTab('b', 1, 1)

    expect(mocked.moveTab).toHaveBeenCalledWith('b', 1, 1)
    const s = useTabsStore.getState()
    expect(s.order).toEqual(['a', 'c', 'b'])
    expect(selectGroupTabs(s, 0).map((t) => t.id)).toEqual(['a'])
    expect(selectGroupTabs(s, 1).map((t) => t.id)).toEqual(['c', 'b'])
    // The moved tab keeps focus, so the focused group follows it into its new pane.
    expect(selectFocusedSlot(s)).toBe(1)
  })

  test('setActiveTab persists the focus and makes the group show that tab', async () => {
    await hydrateWith(
      [tab('a', { sortOrder: 0, lastActiveAt: 5 }), tab('b', { sortOrder: 1 })],
      workspace({ activeTabId: 'a' })
    )
    expect(selectGroupVisibleTab(useTabsStore.getState(), 0)?.id).toBe('a')

    await useTabsStore.getState().setActiveTab('b')

    expect(mocked.setActive).toHaveBeenCalledWith('w1', 'b')
    const s = useTabsStore.getState()
    expect(s.activeTabId).toBe('b')
    expect(selectGroupVisibleTab(s, 0)?.id).toBe('b')
  })

  test('setLayout adopts the layout and the regrouped tabs main answers with', async () => {
    await hydrateWith(
      [...group(0, ['a']), ...group(1, ['b'])],
      workspace({ layout: 'columns', activeTabId: 'a' })
    )
    mocked.setLayout.mockResolvedValue({
      workspace: workspace({ layout: 'single', activeTabId: 'a' }),
      tabs: group(0, ['a', 'b'])
    })

    await useTabsStore.getState().setLayout('single')

    const s = useTabsStore.getState()
    expect(s.layout).toBe('single')
    expect(selectGroupTabs(s, 0).map((t) => t.id)).toEqual(['a', 'b'])
    expect(selectGroupTabs(s, 1)).toEqual([])
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

describe('group selectors', () => {
  test('selectGroupTabs answers only its own group, in bar order', async () => {
    await hydrateWith(
      [...group(0, ['a', 'b']), ...group(1, ['c'])],
      workspace({ layout: 'columns' })
    )
    const s = useTabsStore.getState()
    expect(selectGroupTabs(s, 0).map((t) => t.id)).toEqual(['a', 'b'])
    expect(selectGroupTabs(s, 1).map((t) => t.id)).toEqual(['c'])
    expect(selectGroupTabs(s, 2)).toEqual([])
  })

  test('selectGroupVisibleTab shows the most recently activated tab of the group', async () => {
    await hydrateWith([
      tab('a', { sortOrder: 0, lastActiveAt: 10 }),
      tab('b', { sortOrder: 1, lastActiveAt: 40 }),
      tab('c', { sortOrder: 2, lastActiveAt: 20 })
    ])
    expect(selectGroupVisibleTab(useTabsStore.getState(), 0)?.id).toBe('b')
  })

  test('selectGroupVisibleTab falls back to the first tab of an untouched group', async () => {
    await hydrateWith(group(0, ['a', 'b']))
    expect(selectGroupVisibleTab(useTabsStore.getState(), 0)?.id).toBe('a')
  })

  test('selectGroupVisibleTab is null for an empty group', async () => {
    await hydrateWith(group(0, ['a']), workspace({ layout: 'columns' }))
    expect(selectGroupVisibleTab(useTabsStore.getState(), 1)).toBeNull()
  })

  test('selectFocusedSlot is the active tab group, and 0 when nothing is open', async () => {
    await hydrateWith(
      [...group(0, ['a']), ...group(1, ['b'])],
      workspace({ layout: 'columns', activeTabId: 'b' })
    )
    expect(selectFocusedSlot(useTabsStore.getState())).toBe(1)

    await hydrateWith([], workspace({ layout: 'columns' }))
    expect(selectFocusedSlot(useTabsStore.getState())).toBe(0)
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
  test('nextTab walks the focused group and wraps inside it', async () => {
    await hydrateWith(
      [...group(0, ['a', 'b']), ...group(1, ['c', 'd'])],
      workspace({ layout: 'columns', activeTabId: 'c' })
    )
    await useTabsStore.getState().nextTab()
    expect(useTabsStore.getState().activeTabId).toBe('d')
    await useTabsStore.getState().nextTab()
    // Wrapping stays in group 1; the other group's tabs are never part of the cycle.
    expect(useTabsStore.getState().activeTabId).toBe('c')
  })

  test('nextTab does nothing when the focused group holds a single tab', async () => {
    await hydrateWith(
      [...group(0, ['a', 'b']), ...group(1, ['c'])],
      workspace({ layout: 'columns', activeTabId: 'c' })
    )
    await useTabsStore.getState().nextTab()
    expect(mocked.setActive).not.toHaveBeenCalled()
    expect(useTabsStore.getState().activeTabId).toBe('c')
  })

  test('jumpToTab counts positions from the start of the focused group', async () => {
    await hydrateWith(
      [...group(0, ['a', 'b']), ...group(1, ['c', 'd', 'e'])],
      workspace({ layout: 'columns', activeTabId: 'c' })
    )
    await useTabsStore.getState().jumpToTab(2)
    expect(useTabsStore.getState().activeTabId).toBe('d')
  })

  // Nine fixed accelerators against a variable tab count: the high ones must land somewhere
  // useful rather than doing nothing.
  test('jumpToTab past the group lands on the group last tab', async () => {
    await hydrateWith(
      [...group(0, ['a', 'b']), ...group(1, ['c', 'd', 'e'])],
      workspace({ layout: 'columns', activeTabId: 'c' })
    )
    await useTabsStore.getState().jumpToTab(9)
    expect(useTabsStore.getState().activeTabId).toBe('e')
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
    expect(mocked.create).toHaveBeenCalledWith('w1', 'claude', 0, undefined, undefined)
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
    await hydrateWith(group(0, ['a', 'b']), workspace({ activeTabId: 'b' }))
    mocked.remove.mockResolvedValue(undefined)
    await getCommand('tabs.close')?.handler()
    expect(mocked.remove).toHaveBeenCalledWith('b')
  })

  test('the nine positional jumps are all registered', () => {
    for (let n = 1; n <= 9; n++) {
      expect(getCommand(`tabs.jump.${n}`)?.title).toBe(`Tab ${n}`)
    }
  })

  test('moving a tab left shifts it one place along its own bar', async () => {
    await hydrateWith(
      [...group(0, ['a']), ...group(1, ['b', 'c'])],
      workspace({ layout: 'columns', activeTabId: 'c' })
    )
    mocked.moveTab.mockResolvedValue([...group(0, ['a']), ...group(1, ['c', 'b'])])

    await getCommand('tabs.moveLeft')?.handler()

    expect(mocked.moveTab).toHaveBeenCalledWith('c', 1, 0)
  })

  // The workspace-wide order puts group 0's tabs ahead of 'b', so a bar-order check over the
  // whole list would wrongly report somewhere to go. Only the group's own bar decides.
  test('the move commands are enabled against the group bar rather than the workspace', async () => {
    await hydrateWith(
      [...group(0, ['a']), ...group(1, ['b', 'c'])],
      workspace({ layout: 'columns', activeTabId: 'b' })
    )
    expect(getCommand('tabs.moveLeft')?.enabled?.()).toBe(false)
    expect(getCommand('tabs.moveRight')?.enabled?.()).toBe(true)

    await useTabsStore.getState().setActiveTab('c')
    expect(getCommand('tabs.moveLeft')?.enabled?.()).toBe(true)
    expect(getCommand('tabs.moveRight')?.enabled?.()).toBe(false)
  })

  test('sending a tab to the next pane appends it to that group', async () => {
    await hydrateWith(
      [...group(0, ['a']), ...group(1, ['b', 'c'])],
      workspace({ layout: 'columns', activeTabId: 'a' })
    )
    mocked.moveTab.mockResolvedValue(group(1, ['b', 'c', 'a']))

    await getCommand('tabs.moveToNextPane')?.handler()

    expect(mocked.moveTab).toHaveBeenCalledWith('a', 1, 2)
  })

  // Two panes make the other group both the next one and the previous one, so the step wraps
  // rather than leaving one of the two commands permanently dead.
  test('sending a tab to the previous pane wraps in a two-pane layout', async () => {
    await hydrateWith(
      [...group(0, ['a']), ...group(1, ['b'])],
      workspace({ layout: 'columns', activeTabId: 'a' })
    )
    mocked.moveTab.mockResolvedValue(group(1, ['b', 'a']))

    await getCommand('tabs.moveToPreviousPane')?.handler()

    expect(mocked.moveTab).toHaveBeenCalledWith('a', 1, 1)
  })

  test('the next pane of the last grid group is the first one', async () => {
    await hydrateWith(
      [...group(0, ['a']), ...group(3, ['d'])],
      workspace({ layout: 'grid', activeTabId: 'd' })
    )
    mocked.moveTab.mockResolvedValue(group(0, ['a', 'd']))

    await getCommand('tabs.moveToNextPane')?.handler()

    expect(mocked.moveTab).toHaveBeenCalledWith('d', 0, 1)
  })

  test('there is nowhere to send a tab under the single layout', async () => {
    await hydrateWith(group(0, ['a', 'b']), workspace({ activeTabId: 'a' }))
    expect(getCommand('tabs.moveToNextPane')?.enabled?.()).toBe(false)
    expect(getCommand('tabs.moveToPreviousPane')?.enabled?.()).toBe(false)

    await getCommand('tabs.moveToNextPane')?.handler()
    expect(mocked.moveTab).not.toHaveBeenCalled()
  })
})
