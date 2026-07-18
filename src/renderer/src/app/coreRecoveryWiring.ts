import { useAttentionStore } from '@renderer/features/attention'
import { useProjectsStore } from '@renderer/features/projects'
import { useTabsStore } from '@renderer/features/tabs'
import { markAllInterrupted, setCoreSpawnGate } from '@renderer/features/terminal'
import { useUsageStore } from '@renderer/features/usage'
import { useWorkspacesStore } from '@renderer/features/workspaces'
import { ipc } from '@renderer/shared/ipc/client'

/**
 * The renderer side of core crash recovery (cross-slice, app-layer). A core crash kills
 * every PTY and invalidates every pushed status, so the moment the core leaves ready: mark
 * all live terminal sessions interrupted (they must never be presented as alive) and drop
 * the attention statuses the dead core can no longer retract. While the core is away the
 * terminal spawn gate stays closed so failed attaches cannot degrade into silent spawns.
 * When a core comes back after a crash, re-hydrate the SQLite-backed stores - workspaces,
 * tabs (whose fresh `resumeSessionId` feeds each pane's resume action), projects, usage -
 * and leave the interrupted sessions awaiting the user's explicit respawn.
 * Runs once for the renderer's lifetime.
 */
export function wireCoreRecovery(): void {
  let crashed = false
  ipc().system.onCoreStatus((status) => {
    setCoreSpawnGate(status.state === 'ready')

    if (status.state === 'restarting' || status.state === 'failed') {
      if (crashed) return
      crashed = true
      markAllInterrupted('background services restarted')
      useAttentionStore.getState().clearAll()
      return
    }

    if (status.state === 'ready' && crashed) {
      crashed = false
      void useWorkspacesStore.getState().hydrate()
      void useProjectsStore.getState().load()
      void useUsageStore.getState().hydrate()
      const workspaceId = useTabsStore.getState().workspaceId
      if (workspaceId) void useTabsStore.getState().hydrate(workspaceId)
    }
  })
}
