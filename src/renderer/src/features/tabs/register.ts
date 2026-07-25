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

/**
 * Registers the tabs/layout commands into the command registry. The app-wide tab shortcuts carry
 * no behaviour of their own: the native menu dispatches an id and these handlers are what runs.
 */
export function registerTabsFeature(): void {
  registerCommand({
    id: 'tabs.new',
    title: 'New Tab',
    handler: () => {
      if (!requireWorkspace()) return
      void useTabsStore.getState().createTab(useTabsStore.getState().lastPreset)
    }
  })
  registerCommand({
    id: 'tabs.newWithPreset',
    title: 'New Tab with Preset…',
    handler: () => {
      if (!requireWorkspace()) return
      useTabsStore.getState().setPresetPickerOpen(true)
    }
  })
  registerCommand({
    id: 'tabs.close',
    title: 'Close Tab',
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
    handler: () => void useTabsStore.getState().nextTab()
  })
  for (let position = 1; position <= 9; position++) {
    registerCommand({
      id: `tabs.jump.${position}`,
      title: `Tab ${position}`,
      handler: () => void useTabsStore.getState().jumpToTab(position)
    })
  }
  registerCommand({
    id: 'tabs.newShell',
    title: 'New Shell Tab',
    handler: () => void useTabsStore.getState().createTab('shell')
  })
  registerCommand({
    id: 'tabs.newClaude',
    title: 'New Claude Code Tab',
    handler: () => void useTabsStore.getState().createTab('claude')
  })
  registerCommand({
    id: 'terminal.layoutSingle',
    title: 'Layout: Single',
    handler: () => void useTabsStore.getState().setLayout('single')
  })
  registerCommand({
    id: 'terminal.layoutColumns',
    title: 'Layout: Columns',
    handler: () => void useTabsStore.getState().setLayout('columns')
  })
  registerCommand({
    id: 'terminal.layoutRows',
    title: 'Layout: Rows',
    handler: () => void useTabsStore.getState().setLayout('rows')
  })
  registerCommand({
    id: 'terminal.layoutGrid',
    title: 'Layout: 2×2 Grid',
    handler: () => void useTabsStore.getState().setLayout('grid')
  })
}
