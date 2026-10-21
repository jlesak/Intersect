import type { FixWorktreeClosedEvent } from '@common/domain'
import { usePrInboxStore } from '@renderer/features/prInbox'
import { launchPullRequestFix } from '@renderer/features/workItems'
import { useWorkspacesStore } from '@renderer/features/workspaces'
import { ipc } from '@renderer/shared/ipc/client'
import { useToastStore } from '@renderer/shared/ui/toast'

/** What the user is told about a cleanup, or null when the sidebar change says it all. */
function closedMessage(event: FixWorktreeClosedEvent): string | null {
  switch (event.outcome) {
    case 'removed':
      return event.workspaceRemoved
        ? null
        : `Removed the worktree ${event.path}; close the tabs still open there.`
    case 'dirty':
      return `Kept ${event.path}: it has uncommitted or untracked files. Commit or discard them, then close its last tab again.`
    case 'busy':
      return `Kept ${event.path}: its Claude session was still running after 10 seconds. Open a tab there and close it again to retry.`
    case 'failed':
      return `Could not remove ${event.path}: ${event.detail ?? 'git refused'}. Delete the folder by hand before fixing this pull request again.`
  }
}

function onClosed(event: FixWorktreeClosedEvent): void {
  if (event.workspaceRemoved) useWorkspacesStore.getState().forget(event.workspaceId)
  const message = closedMessage(event)
  if (message) useToastStore.getState().push(message)
}

/**
 * Fixing my own pull request's review comments, across slices (app layer): a fix the PR inbox
 * prepared becomes a Claude tab in its worktree's workspace through the ordinary card-launch
 * path, and the core's report on cleaning that worktree up becomes a toast, or the workspace
 * leaving the sidebar. Returns the teardown.
 */
export function wirePrFix(): () => void {
  const offPending = usePrInboxStore.subscribe((state, prev) => {
    const request = state.pendingFix
    if (!request || request === prev.pendingFix) return
    usePrInboxStore.getState().clearPendingFix()
    launchPullRequestFix(request.pr, request.worktreePath, request.openTab)
  })
  const offClosed = ipc().prInbox.onFixWorktreeClosed(onClosed)
  return () => {
    offPending()
    offClosed()
  }
}
