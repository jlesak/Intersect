import { registerDashboardFeature } from '@renderer/features/dashboard'
import { registerMyWorkFeature } from '@renderer/features/myWork'
import { registerOneOnOneFeature } from '@renderer/features/oneOnOne'
import { registerPrInboxFeature } from '@renderer/features/prInbox'
import { registerSessionsFeature } from '@renderer/features/sessions'
import { registerSettingsFeature } from '@renderer/features/settings'
import { registerTabsFeature } from '@renderer/features/tabs'
import { registerTimeTrackingFeature } from '@renderer/features/timeTracking'
import { registerTodoFeature } from '@renderer/features/todo'
import { registerWorkItemsFeature } from '@renderer/features/workItems'
import { registerWorkspacesFeature } from '@renderer/features/workspaces'

/**
 * The single place feature slices are wired into the app. Adding a slice is an append here plus
 * the slice's own register() - no other shell code changes.
 */
export function registerFeatures(): void {
  registerDashboardFeature()
  registerMyWorkFeature()
  registerTimeTrackingFeature()
  registerTodoFeature()
  registerOneOnOneFeature()
  registerWorkspacesFeature()
  registerTabsFeature()
  registerWorkItemsFeature()
  registerPrInboxFeature()
  registerSessionsFeature()
  registerSettingsFeature()
}
