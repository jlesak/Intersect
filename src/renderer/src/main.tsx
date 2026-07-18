// Must run before anything touches Monaco: wires its web workers to same-origin ES-module chunks.
import './monaco-workers'
import '@xterm/xterm/css/xterm.css'
import './shared/ui/theme.css'
import './shared/ui/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { registerFeatures } from './app/registerFeatures'
import { wireAttention } from './app/attentionWiring'
import { wireCoreRecovery } from './app/coreRecoveryWiring'
import { wireMyWorkPrNav } from './app/myWorkPrNavWiring'
import { wireProjectsToWorkspaces } from './app/projectsWiring'
import { wireSessionResume } from './app/sessionResumeWiring'
import { wireSettings } from './app/settingsWiring'
import { useOneOnOneStore } from './features/oneOnOne'
import { usePrInboxStore } from './features/prInbox'
import { useUsageStore } from './features/usage'
import { useWorkspacesStore } from './features/workspaces'

// Registration is synchronous and must complete before first render so the shell can read the
// registries. Store hydration is fired after render (non-blocking); slices show their own state.
registerFeatures()

const root = document.getElementById('root')
if (!root) throw new Error('root element missing')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)

void useWorkspacesStore.getState().hydrate()
// Load the cached PRs (no network) and start listening for pushed drafts / review-session exits.
void usePrInboxStore.getState().hydrate()
usePrInboxStore.getState().subscribe()
// Listen for finished 1:1 runs pushed from main so the history refreshes live.
useOneOnOneStore.getState().subscribe()
// Load the last captured Claude usage snapshot and keep listening for fresh ones pushed from main.
void useUsageStore.getState().hydrate()
useUsageStore.getState().subscribe()
// Mirror main's session-attention alerts into the pulse UI and report the viewed session back.
wireAttention()
// Bridge the sessions slice's resume requests to the workspaces/tabs slices (cross-slice, app-layer).
wireSessionResume()
// Bridge My Work's PR-radar clicks to the PR Inbox section (cross-slice, app-layer).
wireMyWorkPrNav()
// Re-read workspaces after project-binding changes so assignments stay truthful (cross-slice).
wireProjectsToWorkspaces()
// Hydrate the settings store and keep live terminals following the terminal font size.
wireSettings()
// Mark sessions interrupted on a core crash and re-hydrate the stores once it recovers.
wireCoreRecovery()
