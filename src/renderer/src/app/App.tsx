import { useShallow } from 'zustand/react/shallow'
import { CommandPalette } from '@renderer/features/commandPalette'
import { ProjectContextView, selectActiveProjects, useProjectsStore } from '@renderer/features/projects'
import { selectSelectedWorkspace, useWorkspacesStore } from '@renderer/features/workspaces'
import { getSidebarSections } from '@renderer/shared/registries/sidebarRegistry'
import { Toaster } from '@renderer/shared/ui/Toaster'
import { Sidebar } from './Sidebar'
import { resolveShellContext, useShellStore } from './shellStore'

/**
 * App shell: sidebar plus a main region owned by the resolved context - a project context (the
 * daily default), the virtual Other bucket, or a global section's mainComponent. Switching
 * contexts unmounts the inactive main component rather than hiding it.
 *
 * This is safe for live terminals: the terminal slice keeps its xterm instances (and the PTYs they
 * front) in a module-level Map, and unmounting `WorkspaceView`/`SplitStage`/`TerminalPane` only
 * calls `detachSession` (removes the persisted DOM node from the pane) - never `disposeSession`,
 * which alone kills a PTY and is reserved for tab/workspace deletion. So a running terminal keeps
 * running when we switch to PR Review and is re-attached with its scrollback intact on return.
 * Because that holds, plain conditional rendering is preferred over a CSS display:none toggle.
 */
export function App() {
  const context = useShellStore((s) => s.context)
  const collapsed = useShellStore((s) => s.sidebarCollapsed)
  const projects = useProjectsStore(useShallow(selectActiveProjects))
  const selectedWorkspace = useWorkspacesStore(selectSelectedWorkspace)
  const sections = getSidebarSections()
  const resolved = resolveShellContext(context, projects, sections, selectedWorkspace)

  let main = <div className="ix-main" />
  if (resolved?.kind === 'project' || resolved?.kind === 'other') {
    const key = resolved.kind === 'project' ? resolved.id : 'other'
    main = <ProjectContextView key={key} context={resolved} />
  } else if (resolved?.kind === 'section') {
    const Main = sections.find((s) => s.id === resolved.id)?.mainComponent
    if (Main) main = <Main key={resolved.id} />
  }

  return (
    <div className={`ix-app${collapsed ? ' ix-app--rail' : ''}`}>
      <Sidebar />
      {main}
      <Toaster />
      <CommandPalette />
    </div>
  )
}
