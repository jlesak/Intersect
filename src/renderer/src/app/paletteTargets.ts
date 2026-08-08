import type { PullRequest, SessionSummary, Workspace } from '@common/domain'
import { useCommandPaletteStore } from '@renderer/features/commandPalette'
import { PR_INBOX_SECTION_ID, selectPrList, usePrInboxStore } from '@renderer/features/prInbox'
import { useSessionsStore } from '@renderer/features/sessions'
import { selectWorkspaceList, useWorkspacesStore } from '@renderer/features/workspaces'
import {
  registerCommandProvider,
  type Command
} from '@renderer/shared/registries/commandRegistry'
import { useShellStore } from './shellStore'

/**
 * How much a user has to have typed before the session history is offered. Hundreds of past
 * sessions are worth reaching from the palette but worthless listed at rest, and one character
 * narrows almost nothing - it would only push every real command off the screen.
 */
const SESSION_QUERY_MINIMUM = 2

/** The palette headings the state-derived targets are filed under. */
const WORKSPACE_GROUP = 'Workspaces'
const PR_GROUP = 'Pull Requests'
const SESSION_GROUP = 'Sessions'

/**
 * Send the shell to a workspace's own context before selecting it. Selecting alone would leave
 * the user looking at whichever section they were already on, with the switch having happened
 * somewhere off screen.
 */
function goToWorkspace(workspace: Workspace): void {
  if (workspace.projectId === null) useShellStore.getState().setOtherContext()
  else useShellStore.getState().setActiveProject(workspace.projectId)
  void useWorkspacesStore.getState().select(workspace.id)
}

/**
 * The name of the folder a workspace sits in. A workspace starts out named after its folder but
 * can be renamed away from it, and a renamed workspace is exactly the one its owner still thinks
 * of by its directory - so the folder's name stays worth answering to. The rest of the path does
 * not: nothing on screen shows it, so matching on it would surface a workspace for reasons the
 * user cannot see.
 */
function folderName(folderPath: string): string {
  return folderPath.split('/').filter(Boolean).pop() ?? ''
}

function workspaceCommand(workspace: Workspace): Command {
  return {
    id: `workspaces.goto.${workspace.id}`,
    title: `Switch to workspace: ${workspace.name}`,
    group: WORKSPACE_GROUP,
    keywords: [folderName(workspace.folderPath)].filter(Boolean),
    handler: () => goToWorkspace(workspace)
  }
}

function pullRequestCommand(pr: PullRequest): Command {
  return {
    id: `prInbox.open.${pr.repositoryId}.${pr.prId}`,
    title: `Open PR: ${pr.title}`,
    group: PR_GROUP,
    keywords: [`!${pr.prId}`, pr.repositoryName, pr.authorName],
    handler: () => {
      useShellStore.getState().setActiveSection(PR_INBOX_SECTION_ID)
      void usePrInboxStore.getState().openDetail(pr.repositoryId, pr.prId)
    }
  }
}

function sessionCommand(session: SessionSummary): Command {
  return {
    id: `sessions.resume.${session.id}`,
    title: `Resume session: ${session.title}`,
    group: SESSION_GROUP,
    keywords: [session.folderName, session.gitBranch ?? ''].filter(Boolean),
    // The sessions slice only records the intent; wireSessionResume owns the workspace and tab
    // coordination that follows, exactly as it does for the Sessions list's own resume button.
    handler: () => useSessionsStore.getState().requestResume(session)
  }
}

/**
 * Registers the palette targets that exist only because of what is currently loaded - the open
 * workspaces, the cached pull requests, the indexed sessions.
 *
 * They live in the app layer rather than in their slices because reaching them means cross-slice
 * navigation: a pull request has to bring the shell to the PR section with it, and a workspace to
 * its project context. A feature is not allowed to import the shell.
 *
 * Returns an unsubscribe for the palette-open listener, matching the other app-layer wirings.
 */
export function registerPaletteTargets(): () => void {
  // Index the session history the moment the palette opens, not at boot and not when the Sessions
  // section is first visited. Building the index reads every transcript on disk, which is too much
  // to spend on every launch - but a session target that only appears after the user has already
  // walked to the section saves them exactly the trip it exists to save.
  const stopIndexingOnOpen = useCommandPaletteStore.subscribe((state, previous) => {
    if (!state.open || previous.open) return
    if (useSessionsStore.getState().status === 'idle') void useSessionsStore.getState().hydrate()
  })

  registerCommandProvider(() => selectWorkspaceList(useWorkspacesStore.getState()).map(workspaceCommand))
  registerCommandProvider(() => selectPrList(usePrInboxStore.getState()).map(pullRequestCommand))
  registerCommandProvider((query) =>
    query.trim().length < SESSION_QUERY_MINIMUM
      ? []
      : useSessionsStore.getState().all.map(sessionCommand)
  )

  return stopIndexingOnOpen
}
