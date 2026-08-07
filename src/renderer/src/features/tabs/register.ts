import { registerCommand } from '@renderer/shared/registries/commandRegistry'
import { useToastStore } from '@renderer/shared/ui/toast'
import { useTabsStore } from './store'

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
