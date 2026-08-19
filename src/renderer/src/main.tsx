// Must run before anything touches Monaco: wires its web workers to same-origin ES-module chunks.
import './monaco-workers'
import '@xterm/xterm/css/xterm.css'
import './shared/ui/theme.css'
import './shared/ui/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from './shared/ui/ErrorBoundary'
import { App } from './app/App'
import { registerFeatures } from './app/registerFeatures'
import { registerPaletteTargets } from './app/paletteTargets'
import { registerShellCommands } from './app/shellCommands'
import { wireAttention } from './app/attentionWiring'
import { wireCoreRecovery } from './app/coreRecoveryWiring'
import { wireDashboardNav } from './app/dashboardNavWiring'
import { wireMyWorkPrNav } from './app/myWorkPrNavWiring'
import { wirePrSync } from './app/prSyncWiring'
import { wireProjectsToWorkspaces } from './app/projectsWiring'
import { wireSessionResume } from './app/sessionResumeWiring'
import { wireSettings } from './app/settingsWiring'
import { wireShortcuts } from './app/shortcutWiring'
import { wireTodoFocus } from './app/todoFocusWiring'
import { wireWorkItemLaunch } from './app/workItemLaunchWiring'
import { useCommandPaletteStore } from './features/commandPalette'
import { useMyWorkStore } from './features/myWork'
import { useOneOnOneStore } from './features/oneOnOne'
import { usePrInboxStore } from './features/prInbox'
import { useTodoStore } from './features/todo'
import { useUsageStore } from './features/usage'
import { useWorkspacesStore } from './features/workspaces'
import { initRendererLogging } from './shared/logging/logger'

// Diagnostics come first so that a failure in registration or in the very first render already
// reaches the log file rather than only the devtools console a user does not have open.
//
// The boot record goes out immediately, before anything else can fail. Every other renderer record
// reports something going wrong, so on a healthy run this is the only trace the renderer leaves -
// and without it the log file cannot tell a renderer that stayed quiet because all was well from
// one whose route to the file was broken the whole time. It also dates the renderer's start
// against the lifecycle records main and the core write for themselves.
initRendererLogging().info('renderer boot')

// Registration is synchronous and must complete before first render so the shell can read the
// registries. Store hydration is fired after render (non-blocking); slices show their own state.
registerFeatures()
registerShellCommands()
registerPaletteTargets()

const root = document.getElementById('root')
if (!root) throw new Error('root element missing')

// The outermost boundary is the last resort: anything the shell's own region boundary did not
// contain would otherwise leave a blank window with no message and no way out but relaunching.
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary scope="window">
      <App />
    </ErrorBoundary>
  </StrictMode>
)

void useWorkspacesStore.getState().hydrate()
// Read the palette's recently-used commands, so the first Cmd+K of the day already leads with the
// user's own habits rather than an alphabetical listing.
void useCommandPaletteStore.getState().hydrateRecent()
// Load the cached PRs (no network) and start listening for pushed drafts / review-session exits.
void usePrInboxStore.getState().hydrate()
usePrInboxStore.getState().subscribe()
// Listen for finished 1:1 runs pushed from main so the history refreshes live.
useOneOnOneStore.getState().subscribe()
// Listen for completed Jira background refreshes so the My Work board updates live.
useMyWorkStore.getState().subscribe()
// Load the last captured Claude usage snapshot and keep listening for fresh ones pushed from main.
void useUsageStore.getState().hydrate()
useUsageStore.getState().subscribe()
// Load the task list at boot: the rail's open-task count and the Dashboard's deadlines both read it
// without the user ever having opened the TODO section.
void useTodoStore.getState().load()
// Mirror main's session-attention alerts into the pulse UI and report the viewed session back.
wireAttention()
// Bridge the sessions slice's resume requests to the workspaces/tabs slices (cross-slice, app-layer).
wireSessionResume()
// Bridge My Work's PR-radar clicks to the PR Inbox section (cross-slice, app-layer).
wireMyWorkPrNav()
// Send the user to the TODO section when any surface asks to focus a task (cross-slice, app-layer).
wireTodoFocus()
// Turn the Dashboard's rows into the PR detail and terminal they point at (cross-slice, app-layer).
wireDashboardNav()
// Follow the tabs slice's workspace with its work-item refs and execute card launches.
wireWorkItemLaunch()
// Re-read workspaces after project-binding changes so assignments stay truthful (cross-slice).
wireProjectsToWorkspaces()
// Hydrate the settings store and keep live terminals following the terminal font size.
wireSettings()
// Refresh the PR board at boot and on focus regain, once the settings and the cache have loaded.
wirePrSync()
// Mark sessions interrupted on a core crash and re-hydrate the stores once it recovers.
wireCoreRecovery()
// Run the command a native menu accelerator asked for (the app-wide keyboard layer).
wireShortcuts()
