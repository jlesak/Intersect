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
import { usePrInboxStore } from './features/prInbox'
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
// Mirror main's session-attention alerts into the pulse UI and report the viewed session back.
wireAttention()
