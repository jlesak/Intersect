import { registerTabsFeature } from '@renderer/features/tabs'
import { registerWorkspacesFeature } from '@renderer/features/workspaces'

/**
 * The single place feature slices are wired into the app. Adding a slice is an append here plus
 * the slice's own register() - no other shell code changes.
 */
export function registerFeatures(): void {
  registerWorkspacesFeature()
  registerTabsFeature()
}
