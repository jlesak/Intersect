import { createElement } from 'react'
import { registerCommand } from '@renderer/shared/registries/commandRegistry'
import { registerSidebarSection } from '@renderer/shared/registries/sidebarRegistry'
import { IconInbox } from '@renderer/shared/ui/icons'
import { PrInboxView } from './components/PrInboxView'
import { selectActionCount, usePrInboxStore } from './store'

/** The PR Review section's registry id, exported so other slices can navigate to it. */
export const PR_INBOX_SECTION_ID = 'prInbox'

/** Live count of PRs needing my action, shown on the rail button. */
function PrActionBadge() {
  const count = usePrInboxStore(selectActionCount)
  if (count === 0) return null
  return createElement('span', { className: 'ix-rail__badge', 'data-testid': 'pr-badge' }, count)
}

/** Registers the PR-review sidebar section (owning the main area) and its commands. */
export function registerPrInboxFeature(): void {
  registerSidebarSection({
    id: PR_INBOX_SECTION_ID,
    order: 14,
    label: 'PR Review',
    icon: IconInbox,
    badge: PrActionBadge,
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
