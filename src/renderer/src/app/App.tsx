import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CommandPalette } from '@renderer/features/commandPalette'
import { ProjectContextView, selectActiveProjects, useProjectsStore } from '@renderer/features/projects'
import { WorkItemPickerHost } from '@renderer/features/workItems'
import { selectSelectedWorkspace, useWorkspacesStore } from '@renderer/features/workspaces'
import {
  clearUnrecoveredCrash,
  CRASH_SETTLE_MS,
  reloadWindow
} from '@renderer/shared/recovery/bootRecovery'
import { getSidebarSections } from '@renderer/shared/registries/sidebarRegistry'
import { ErrorBoundary } from '@renderer/shared/ui/ErrorBoundary'
import { Toaster } from '@renderer/shared/ui/Toaster'
import { CoreStatusOverlay } from './CoreStatusOverlay'
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
  const safeMode = useShellStore((s) => s.safeMode)
  const projects = useProjectsStore(useShallow(selectActiveProjects))
  const selectedWorkspace = useWorkspacesStore(selectSelectedWorkspace)
  const sections = getSidebarSections()
  const resolved = resolveShellContext(context, projects, sections, selectedWorkspace)

  // Withdraw the crash marker only once the tree has stayed up for a while. Clearing it on mount
  // alone would be too generous: a shell that renders and then throws seconds later on the same
  // persisted value would clear it on every boot, and the window fallback would never learn that
  // reloading has stopped helping. A crash inside the settle window unmounts this and the timer
  // goes with it, which is exactly the case the marker exists to record.
  useEffect(() => {
    const settled = setTimeout(clearUnrecoveredCrash, CRASH_SETTLE_MS)
    return () => clearTimeout(settled)
  }, [])

  let main = <div className="ix-main" />
  let mainKey = 'empty'
  if (resolved?.kind === 'project' || resolved?.kind === 'other') {
    mainKey = resolved.kind === 'project' ? resolved.id : 'other'
    main = <ProjectContextView key={mainKey} context={resolved} />
  } else if (resolved?.kind === 'section') {
    const Main = sections.find((s) => s.id === resolved.id)?.mainComponent
    if (Main) {
      mainKey = resolved.id
      main = <Main key={mainKey} />
    }
  }

  return (
    <div className={`ix-app${collapsed ? ' ix-app--rail' : ''}`}>
      <Sidebar />
      {/* Keyed by context so navigating away from a crashed view always lands on a fresh mount.
          The sidebar is outside the boundary, so a crash here leaves it live and the recovery
          line can send the user straight to it. */}
      <ErrorBoundary
        key={mainKey}
        scope="region"
        recovery="The rest of the app is unaffected. Pick another project or section in the sidebar, or retry this one."
      >
        {main}
      </ErrorBoundary>
      {safeMode && <SafeModeBanner />}
      <Toaster />
      <CommandPalette />
      <WorkItemPickerHost />
      <CoreStatusOverlay />
    </div>
  )
}

/**
 * The standing reminder that this launch is not a normal one. Safe mode hides the crash rather
 * than resolving it, so a user who simply carries on working in it would later report that
 * Intersect lost their terminals and their session resume. Naming the state and keeping the way
 * out in reach is what stops that.
 */
function SafeModeBanner() {
  return (
    <div className="ix-safemode" role="status">
      <span className="ix-safemode__text">
        Safe mode: the saved session and workspace state were not restored. The next launch is an
        ordinary one.
      </span>
      <button type="button" className="ix-btn" onClick={reloadWindow}>
        Exit safe mode
      </button>
    </div>
  )
}
