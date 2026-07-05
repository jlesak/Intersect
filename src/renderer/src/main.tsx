import '@xterm/xterm/css/xterm.css'
import './shared/ui/theme.css'
import './shared/ui/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { registerFeatures } from './app/registerFeatures'
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
