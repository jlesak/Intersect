import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { DEFAULT_SIDEBAR_LAYOUT, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from '@common/domain'
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
import { Dialog } from '@renderer/shared/ui/Dialog'
import { ErrorBoundary } from '@renderer/shared/ui/ErrorBoundary'
import { RecoveryEscapes } from '@renderer/shared/ui/RecoveryEscapes'
import { Toaster } from '@renderer/shared/ui/Toaster'
import { CoreStatusOverlay } from './CoreStatusOverlay'
import { PanelResizer } from './PanelResizer'
import { useSidebarLayoutStore } from './sidebarLayout'
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
  const sidebarWidth = useSidebarLayoutStore((s) => s.width)
  const projects = useProjectsStore(useShallow(selectActiveProjects))
  const selectedWorkspace = useWorkspacesStore(selectSelectedWorkspace)
  const sections = getSidebarSections()
  const resolved = resolveShellContext(context, projects, sections, selectedWorkspace)

  // Withdraw the crash marker only once the tree has stayed up for a while. Clearing it on mount
  // alone would be too generous: a shell that renders and then throws seconds later on the same
  // persisted value would clear it on every boot, and the window fallback would never learn that
  // reloading has stopped helping. A crash inside the settle window unmounts this and the timer
  // goes with it, which is exactly the case the marker exists to record.
  //
  // A safe-mode session withdraws nothing. It comes up without the saved state, which is evidence
  // about safe mode alone, so counting it as a success would hand the user the plain card on the
  // very next ordinary crash after they had already earned the ways out. The marker keeps standing
  // until an ordinary launch stays up and earns its removal.
  useEffect(() => {
    if (safeMode) return
    const settled = setTimeout(clearUnrecoveredCrash, CRASH_SETTLE_MS)
    return () => clearTimeout(settled)
  }, [safeMode])

  // The sidebar's own sizes. Safe mode deliberately keeps the defaults: this is the launch that
  // comes up without saved state, and a sidebar dragged to something unusable is exactly the state
  // it exists to escape. A pending drag must not be stranded by the window going away.
  useEffect(() => {
    if (safeMode) return
    void useSidebarLayoutStore.getState().hydrate()
    const flush = (): void => useSidebarLayoutStore.getState().flush()
    window.addEventListener('beforeunload', flush)
    return () => {
      flush()
      window.removeEventListener('beforeunload', flush)
    }
  }, [safeMode])

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
    <div
      className={`ix-app${collapsed ? ' ix-app--rail' : ''}`}
      style={{ '--sidebar-w': `${sidebarWidth}px` } as React.CSSProperties}
    >
      <Sidebar />
      {/* The sidebar's own edge. Outside the sidebar, which clips and scrolls its contents, so the
          grip stays put and full height however far the sidebar is scrolled. */}
      {!collapsed && (
        <PanelResizer
          orientation="vertical"
          label="Sidebar width"
          testId="sidebar-width-resizer"
          size={() => sidebarWidth}
          min={SIDEBAR_WIDTH_MIN}
          max={SIDEBAR_WIDTH_MAX}
          onResize={(px) => useSidebarLayoutStore.getState().setWidth(px)}
          onCommit={() => useSidebarLayoutStore.getState().flush()}
          onReset={() => useSidebarLayoutStore.getState().setWidth(DEFAULT_SIDEBAR_LAYOUT.width)}
        />
      )}
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
 *
 * The recovery options ride along because this session is where the diagnosis lands: an app that
 * comes up here and went down on the launch before it points straight at the saved state, and that
 * is the moment to act. A button opens them, so the strip itself stays a line of text and each
 * escape keeps the sentence naming what it costs.
 */
function SafeModeBanner() {
  const [showingOptions, setShowingOptions] = useState(false)
  return (
    <div className="ix-safemode" role="status">
      <span className="ix-safemode__text">
        Safe mode: the saved session and workspace state were not restored. The next launch is an
        ordinary one.
      </span>
      <div className="ix-safemode__actions">
        <button type="button" className="ix-btn" onClick={() => setShowingOptions(true)}>
          Recovery options
        </button>
        <button type="button" className="ix-btn" onClick={reloadWindow}>
          Exit safe mode
        </button>
      </div>

      {showingOptions && (
        <Dialog
          title="Recovery options"
          onClose={() => setShowingOptions(false)}
          actions={
            <button type="button" className="ix-btn" onClick={() => setShowingOptions(false)}>
              Close
            </button>
          }
        >
          <p className="ix-crash__list-lead">
            This launch left the saved session and workspace state alone. If the ordinary launch
            before it went down, that state is what these act on, least destructive first.
          </p>
          <RecoveryEscapes offerSafeMode={false} />
        </Dialog>
      )}
    </div>
  )
}
