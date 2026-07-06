import { CommandPalette } from '@renderer/features/commandPalette'
import { getSidebarSections } from '@renderer/shared/registries/sidebarRegistry'
import { Toaster } from '@renderer/shared/ui/Toaster'
import { Sidebar } from './Sidebar'
import { resolveActiveSection, useShellStore } from './shellStore'

/**
 * App shell: sidebar plus a main region owned by the active section's mainComponent. Switching
 * sections unmounts the inactive section's main component rather than hiding it.
 *
 * This is safe for live terminals: the terminal slice keeps its xterm instances (and the PTYs they
 * front) in a module-level Map, and unmounting `WorkspaceView`/`SplitStage`/`TerminalPane` only
 * calls `detachSession` (removes the persisted DOM node from the pane) - never `disposeSession`,
 * which alone kills a PTY and is reserved for tab/workspace deletion. So a running terminal keeps
 * running when we switch to PR Review and is re-attached with its scrollback intact on return.
 * Because that holds, plain conditional rendering is preferred over a CSS display:none toggle.
 */
export function App() {
  const activeSectionId = useShellStore((s) => s.activeSectionId)
  const collapsed = useShellStore((s) => s.sidebarCollapsed)
  const active = resolveActiveSection(getSidebarSections(), activeSectionId)
  const Main = active?.mainComponent

  return (
    <div className={`ix-app${collapsed ? ' ix-app--rail' : ''}`}>
      <Sidebar />
      {Main ? <Main key={active?.id} /> : <div className="ix-main" />}
      <Toaster />
      <CommandPalette />
    </div>
  )
}
