import { registerCommand } from '@renderer/shared/registries/commandRegistry'
import { useTabsStore } from './store'

/** Registers the tabs/layout commands into the command registry (data-only; no palette yet). */
export function registerTabsFeature(): void {
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
