import { oldestWaitingSession, useAttentionStore } from '@renderer/features/attention'
import { selectActiveProjects, useProjectsStore } from '@renderer/features/projects'
import { selectSelectedWorkspace, useWorkspacesStore } from '@renderer/features/workspaces'
import { registerCommand } from '@renderer/shared/registries/commandRegistry'
import { getSidebarSections } from '@renderer/shared/registries/sidebarRegistry'
import { navigateToSession } from './attentionWiring'
import { resolveShellContext, useShellStore } from './shellStore'

/**
 * Move the screen to the next project pin, wrapping past the last one back to the first, so a
 * single key walks the whole set. Off a project - on a global section, or in the Other bucket - the
 * walk starts at the first pin, which makes this a way back into project context as well as a way
 * around it. Only a single project already on screen leaves nowhere to go.
 *
 * Exported for tests.
 */
export function nextProject(): void {
  const projects = selectActiveProjects(useProjectsStore.getState())
  if (projects.length === 0) return
  const resolved = resolveShellContext(
    useShellStore.getState().context,
    projects,
    getSidebarSections(),
    selectSelectedWorkspace(useWorkspacesStore.getState())
  )
  const current = resolved?.kind === 'project' ? projects.findIndex((p) => p.id === resolved.id) : -1
  const next = projects[current === -1 ? 0 : (current + 1) % projects.length]
  useShellStore.getState().setActiveProject(next.id)
}

/** The palette heading for commands that move the user around the app rather than change anything. */
const NAVIGATE_GROUP = 'Navigate'

/**
 * Registers the app-wide commands that steer the shell itself rather than one feature slice. They
 * live here because they reach for shell state and cross-slice navigation, which a feature is not
 * allowed to import.
 */
export function registerShellCommands(): void {
  registerCommand({
    id: 'shell.toggleSidebar',
    title: 'Toggle Sidebar',
    group: NAVIGATE_GROUP,
    keywords: ['hide', 'show', 'rail', 'panel', 'collapse'],
    handler: () => useShellStore.getState().toggleSidebar()
  })
  registerCommand({
    id: 'projects.next',
    title: 'Switch Project',
    group: NAVIGATE_GROUP,
    keywords: ['next', 'cycle', 'change', 'repo'],
    enabled: () => selectActiveProjects(useProjectsStore.getState()).length > 0,
    handler: nextProject
  })
  registerCommand({
    id: 'attention.jumpOldestWaiting',
    title: 'Jump to Waiting Session',
    group: NAVIGATE_GROUP,
    keywords: ['blocked', 'attention', 'prompt', 'oldest'],
    enabled: () => oldestWaitingSession(useAttentionStore.getState().status) !== undefined,
    handler: () => {
      const sessionId = oldestWaitingSession(useAttentionStore.getState().status)
      if (sessionId !== undefined) void navigateToSession(sessionId)
    }
  })
}
