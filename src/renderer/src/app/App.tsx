import { CommandPalette } from '@renderer/features/commandPalette'
import { getSidebarSections } from '@renderer/shared/registries/sidebarRegistry'
import { Toaster } from '@renderer/shared/ui/Toaster'
import { Sidebar } from './Sidebar'

/**
 * App shell: sidebar plus a main region owned by the active section's mainComponent. For this
 * MVP the workspaces section owns the main area; the mainComponent field is the seam a future
 * slice uses to claim it without editing the shell.
 */
export function App() {
  const active = getSidebarSections().find((s) => s.mainComponent)
  const Main = active?.mainComponent
  return (
    <div className="jv-app">
      <Sidebar />
      {Main ? <Main /> : <div className="jv-main" />}
      <Toaster />
      <CommandPalette />
    </div>
  )
}
