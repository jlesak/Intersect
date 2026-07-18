import { registerCommand } from '@renderer/shared/registries/commandRegistry'
import { useTabsStore } from '@renderer/features/tabs'
import { useWorkItemsStore } from './store'

/** Registers the palette command opening the work-item picker for the active tab. */
export function registerWorkItemsFeature(): void {
  registerCommand({
    id: 'workItems.setForActiveTab',
    title: 'Session: Set Work Item',
    handler: () => {
      const tabId = useTabsStore.getState().activeTabId
      if (tabId) useWorkItemsStore.getState().openPicker(tabId)
    }
  })
}
