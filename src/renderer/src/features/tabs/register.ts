import { slotCount } from '@common/layout'
import { registerCommand } from '@renderer/shared/registries/commandRegistry'
import { useToastStore } from '@renderer/shared/ui/toast'
import { selectFocusedSlot, selectGroupTabs, useTabsStore } from './store'

/**
 * A tab needs a workspace to live in. Reached from a menu accelerator there is no button to grey
 * out, so say why nothing happened rather than letting the key look broken.
 */
function requireWorkspace(): boolean {
  if (useTabsStore.getState().workspaceId !== null) return true
  useToastStore.getState().push('Select a workspace first')
  return false
}

/** Whether a workspace is open for a new tab to be created in. */
const hasWorkspace = (): boolean => useTabsStore.getState().workspaceId !== null

/**
 * The bar the tab commands act on: the focused group, the ids it holds in bar order, and where
 * the active tab sits in it (-1 when there is no active tab). Every move is group-scoped, so a
 * tab at the left edge of its own bar has nowhere further left to go even when another group's
 * tabs precede it in the workspace-wide order.
 */
function focusedGroup(): { slot: number; ids: string[]; at: number } {
  const state = useTabsStore.getState()
  const slot = selectFocusedSlot(state)
  const ids = selectGroupTabs(state, slot).map((tab) => tab.id)
  return { slot, ids, at: state.activeTabId === null ? -1 : ids.indexOf(state.activeTabId) }
}

/** Whether the active tab has anywhere to go in the given direction within its own group. */
const canMove = (direction: -1 | 1): (() => boolean) => {
  return () => {
    const { ids, at } = focusedGroup()
    const target = at + direction
    return at !== -1 && target >= 0 && target < ids.length
  }
}

/** Shift the active tab one position along its own group's bar. */
function moveActiveTab(direction: -1 | 1): void {
  const { slot, ids, at } = focusedGroup()
  const target = at + direction
  if (at === -1 || target < 0 || target >= ids.length) return
  void useTabsStore.getState().moveTab(ids[at], slot, target)
}

/** Whether the layout has a second group for the active tab to be sent to. */
const canMoveToPane = (): boolean => {
  const state = useTabsStore.getState()
  return state.activeTabId !== null && slotCount(state.layout) > 1
}

/**
 * Send the active tab to the neighbouring group, appended at the end of that group's bar. The
 * step wraps, so both directions stay usable in a two-pane layout where the other group is at
 * once the next one and the previous one. The tab keeps focus, which moves the focused group
 * with it and lets a run of these commands walk a tab around the whole split.
 */
function moveActiveTabToPane(direction: -1 | 1): void {
  const state = useTabsStore.getState()
  const id = state.activeTabId
  const groups = slotCount(state.layout)
  if (id === null || groups < 2) return
  const target = (selectFocusedSlot(state) + direction + groups) % groups
  void useTabsStore.getState().moveTab(id, target, selectGroupTabs(state, target).length)
}

/** The palette heading the tab and layout commands are filed under. */
const GROUP = 'Tabs & Layout'

/**
 * Registers the tabs/layout commands into the command registry. The app-wide tab shortcuts carry
 * no behaviour of their own: the native menu dispatches an id and these handlers are what runs.
 */
export function registerTabsFeature(): void {
  registerCommand({
    id: 'tabs.new',
    title: 'New Tab',
    group: GROUP,
    keywords: ['open', 'create'],
    enabled: hasWorkspace,
    handler: () => {
      if (!requireWorkspace()) return
      void useTabsStore.getState().createTab(useTabsStore.getState().lastPreset)
    }
  })
  registerCommand({
    id: 'tabs.newWithPreset',
    title: 'New Tab with Preset…',
    group: GROUP,
    keywords: ['open', 'create', 'shell', 'claude'],
    enabled: hasWorkspace,
    handler: () => {
      if (!requireWorkspace()) return
      useTabsStore.getState().setPresetPickerOpen(true)
    }
  })
  registerCommand({
    id: 'tabs.close',
    title: 'Close Tab',
    group: GROUP,
    keywords: ['quit', 'kill', 'remove'],
    enabled: () => useTabsStore.getState().activeTabId !== null,
    handler: () => {
      // The File menu item stays enabled whatever the tab count, so an empty workspace is a
      // no-op here rather than a disabled item that would need the menu rebuilt on every change.
      const { activeTabId, removeTab } = useTabsStore.getState()
      if (activeTabId === null) return
      void removeTab(activeTabId)
    }
  })
  registerCommand({
    id: 'tabs.next',
    title: 'Next Tab',
    group: GROUP,
    keywords: ['cycle', 'switch'],
    enabled: () => useTabsStore.getState().activeTabId !== null,
    handler: () => void useTabsStore.getState().nextTab()
  })
  for (let position = 1; position <= 9; position++) {
    registerCommand({
      id: `tabs.jump.${position}`,
      title: `Tab ${position}`,
      group: GROUP,
      handler: () => void useTabsStore.getState().jumpToTab(position)
    })
  }
  registerCommand({
    id: 'tabs.newShell',
    title: 'New Shell Tab',
    group: GROUP,
    keywords: ['bash', 'zsh', 'terminal', 'console'],
    enabled: hasWorkspace,
    handler: () => void useTabsStore.getState().createTab('shell')
  })
  registerCommand({
    id: 'tabs.newClaude',
    title: 'New Claude Code Tab',
    group: GROUP,
    keywords: ['ai', 'agent', 'cc'],
    enabled: hasWorkspace,
    handler: () => void useTabsStore.getState().createTab('claude')
  })
  registerCommand({
    id: 'tabs.moveLeft',
    title: 'Move Tab Left',
    group: GROUP,
    keywords: ['reorder', 'shift', 'before'],
    enabled: canMove(-1),
    handler: () => moveActiveTab(-1)
  })
  registerCommand({
    id: 'tabs.moveRight',
    title: 'Move Tab Right',
    group: GROUP,
    keywords: ['reorder', 'shift', 'after'],
    enabled: canMove(1),
    handler: () => moveActiveTab(1)
  })
  registerCommand({
    id: 'tabs.moveToNextPane',
    title: 'Move Tab to Next Pane',
    group: GROUP,
    keywords: ['group', 'split', 'send', 'right', 'down'],
    enabled: canMoveToPane,
    handler: () => moveActiveTabToPane(1)
  })
  registerCommand({
    id: 'tabs.moveToPreviousPane',
    title: 'Move Tab to Previous Pane',
    group: GROUP,
    keywords: ['group', 'split', 'send', 'left', 'up'],
    enabled: canMoveToPane,
    handler: () => moveActiveTabToPane(-1)
  })
  registerCommand({
    id: 'terminal.layoutSingle',
    title: 'Layout: Single',
    group: GROUP,
    keywords: ['pane', 'unsplit', 'one'],
    handler: () => void useTabsStore.getState().setLayout('single')
  })
  registerCommand({
    id: 'terminal.layoutColumns',
    title: 'Layout: Columns',
    group: GROUP,
    keywords: ['pane', 'split', 'vertical', 'side by side'],
    handler: () => void useTabsStore.getState().setLayout('columns')
  })
  registerCommand({
    id: 'terminal.layoutRows',
    title: 'Layout: Rows',
    group: GROUP,
    keywords: ['pane', 'split', 'horizontal', 'stacked'],
    handler: () => void useTabsStore.getState().setLayout('rows')
  })
  registerCommand({
    id: 'terminal.layoutGrid',
    title: 'Layout: 2×2 Grid',
    group: GROUP,
    keywords: ['pane', 'split', 'four', 'quad'],
    handler: () => void useTabsStore.getState().setLayout('grid')
  })
}
