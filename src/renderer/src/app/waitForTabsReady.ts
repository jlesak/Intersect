import { useTabsStore } from '@renderer/features/tabs'

/**
 * Resolve once the tabs store has finished hydrating for the given workspace, with a safety timeout
 * so a caller can never hang if hydration is interrupted. Shared by the cross-slice coordinators
 * (notification navigation, session resume) that switch workspaces and then act on their tabs.
 */
export function waitForTabsReady(workspaceId: string): Promise<void> {
  const ready = (): boolean => {
    const t = useTabsStore.getState()
    return t.status === 'ready' && t.workspaceId === workspaceId
  }
  if (ready()) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe()
      resolve()
    }, 3000)
    const unsubscribe = useTabsStore.subscribe(() => {
      if (!ready()) return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    })
  })
}
