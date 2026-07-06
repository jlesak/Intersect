import { registerCommand } from '@renderer/shared/registries/commandRegistry'
import { registerSidebarSection } from '@renderer/shared/registries/sidebarRegistry'
import { IconInbox } from '@renderer/shared/ui/icons'
import { PrInboxView } from './components/PrInboxView'
import { PrList } from './components/PrList'
import { usePrInboxStore } from './store'

/** Registers the PR-review sidebar section (owning the main area) and its commands. */
export function registerPrInboxFeature(): void {
  registerSidebarSection({
    id: 'prInbox',
    order: 1,
    label: 'PR Review',
    icon: IconInbox,
    component: PrList,
    mainComponent: PrInboxView
  })
  registerCommand({
    id: 'prInbox.sync',
    title: 'Sync Pull Requests',
    handler: () => usePrInboxStore.getState().sync()
  })
  registerCommand({
    id: 'prInbox.review',
    title: 'Review PR with Claude Code',
    handler: () => usePrInboxStore.getState().startReview()
  })
}
