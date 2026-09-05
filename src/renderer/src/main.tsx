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
import { useSidebarLayoutStore } from './app/sidebarLayout'
import { wireTodoFocus } from './app/todoFocusWiring'
import { wireWorkItemLaunch } from './app/workItemLaunchWiring'
import { useCommandPaletteStore } from './features/commandPalette'
import { useMyWorkStore } from './features/myWork'
import { useOneOnOneStore } from './features/oneOnOne'
import { usePrInboxStore } from './features/prInbox'
import { useTimeTrackingStore } from './features/timeTracking'
import { useTodoStore } from './features/todo'
import { useUsageStore } from './features/usage'
import { SETTINGS_SECTION_ID } from './features/settings'
import { useWorkspacesStore } from './features/workspaces'
import { initRendererLogging } from './shared/logging/logger'
import { consumeSafeModeRequest, consumeViewStateReset } from './shared/recovery/bootRecovery'
import { useToastStore } from './shared/ui/toast'
import { useShellStore } from './app/shellStore'

// Diagnostics come first so that a failure in registration or in the very first render already
// reaches the log file rather than only the devtools console a user does not have open.
//
// The boot record goes out immediately, before anything else can fail. Every other renderer record
// reports something going wrong, so on a healthy run this is the only trace the renderer leaves -
// and without it the log file cannot tell a renderer that stayed quiet because all was well from
// one whose route to the file was broken the whole time. It also dates the renderer's start
// against the lifecycle records main and the core write for themselves.
const bootLog = initRendererLogging()

// Both flags are one-shot requests the previous window left behind, and both are consumed here,
// before anything reads them a second time. Safe mode has to be known before the first render,
// because it decides what the shell restores; the reset note only has to reach the toast.
const safeMode = consumeSafeModeRequest()
const afterViewStateReset = consumeViewStateReset()
bootLog.info('renderer boot', { data: { safeMode, afterViewStateReset } })

// Registration is synchronous and must complete before first render so the shell can read the
// registries. Store hydration is fired after render (non-blocking); slices show their own state.
registerFeatures()
registerShellCommands()
registerPaletteTargets()

// Safe mode pins the shell to a section before the first render. That single move is what keeps
// the whole restore path off screen - the workspace view, the pane grid, the tab bars and the
// automatic session resume all hang off a resolved project or workspace context, and there is
// none. The stores below are left unhydrated for the same reason.
if (safeMode) {
  useShellStore.setState({ safeMode: true, context: { kind: 'section', id: SETTINGS_SECTION_ID } })
}

if (afterViewStateReset) {
  // Said on the boot that follows the reset, because that is the first moment anything on screen
  // reflects it - and it is what tells a reset that worked apart from a boot that happened to.
  useToastStore
    .getState()
    .push('View and layout state was reset. Pane layouts, dividers and the remembered workspace are cleared.')
}

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

// Listen for finished 1:1 runs pushed from main so the history refreshes live.
useOneOnOneStore.getState().subscribe()
// Listen for completed Jira background refreshes so the My Work board updates live.
useMyWorkStore.getState().subscribe()
// Mirror main's session-attention alerts into the pulse UI and report the viewed session back.
wireAttention()
// Bridge My Work's PR-radar clicks to the PR Inbox section (cross-slice, app-layer).
wireMyWorkPrNav()
// Send the user to the TODO section when any surface asks to focus a task (cross-slice, app-layer).
wireTodoFocus()
// Turn the Dashboard's rows into the PR detail and terminal they point at (cross-slice, app-layer).
wireDashboardNav()
// Follow the tabs slice's workspace with its work-item refs and execute card launches.
wireWorkItemLaunch()
// Hydrate the settings store and keep live terminals following the terminal font size.
wireSettings()
// Run the command a native menu accelerator asked for (the app-wide keyboard layer).
wireShortcuts()

// Everything from here restores what the last session left behind, which is the one thing safe
// mode exists to leave alone: the crash it is an escape from repeats on every ordinary boot, and
// the likeliest cause is among these rows. Skipping them also keeps the terminal panes and the
// automatic session resume off screen, since both hang off a hydrated workspace.
if (!safeMode) {
  void useWorkspacesStore.getState().hydrate()
  // Read the palette's recently-used commands, so the first Cmd+K of the day already leads with
  // the user's own habits rather than an alphabetical listing.
  void useCommandPaletteStore.getState().hydrateRecent()
  // Load the cached PRs (no network) and start listening for pushed drafts / review-session exits.
  void usePrInboxStore.getState().hydrate()
  usePrInboxStore.getState().subscribe()
  // Load the last captured Claude usage snapshot and keep listening for fresh ones from main.
  void useUsageStore.getState().hydrate()
  useUsageStore.getState().subscribe()
  // Load the task list at boot: the rail's open-task count and the Dashboard's deadlines both read
  // it without the user ever having opened the TODO section.
  void useTodoStore.getState().load()
  // Read the running work timer, so a timer left running across a relaunch is on screen wherever
  // the user opens the app. Deliberately narrower than hydrate(): the week itself is pulled only by
  // the surfaces that show it.
  void useTimeTrackingStore.getState().loadTimer()
  // The sidebar's dragged sizes. Safe mode keeps the defaults: a sidebar dragged to something
  // unusable is exactly the kind of state it exists to escape.
  void useSidebarLayoutStore.getState().hydrate()
  // Bridge the sessions slice's resume requests to the workspaces/tabs slices (cross-slice).
  wireSessionResume()
  // Re-read workspaces after project-binding changes so assignments stay truthful (cross-slice).
  wireProjectsToWorkspaces()
  // Refresh the PR board at boot and on focus regain, once settings and the cache have loaded.
  wirePrSync()
  // Mark sessions interrupted on a core crash and re-hydrate the stores once it recovers. Left out
  // of safe mode because its recovery path re-hydrates exactly what safe mode declined to load.
  wireCoreRecovery()
}
