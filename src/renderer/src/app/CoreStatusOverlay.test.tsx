import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { CoreStatusOverlay } from './CoreStatusOverlay'

// Vitest transforms TSX without the renderer's Vite React plugin, so provide its classic JSX
// runtime explicitly for the imported production component.
vi.stubGlobal('React', React)

describe('CoreStatusOverlay', () => {
  test('renders nothing while the core is starting or ready', () => {
    expect(
      renderToStaticMarkup(
        React.createElement(CoreStatusOverlay, { initialStatus: { state: 'starting' } })
      )
    ).toBe('')
    expect(
      renderToStaticMarkup(
        React.createElement(CoreStatusOverlay, { initialStatus: { state: 'ready' } })
      )
    ).toBe('')
  })

  test('a failed core shows the reason and a restart action', () => {
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(
      React.createElement(CoreStatusOverlay, {
        initialStatus: { state: 'failed', message: 'core bootstrap failed: db is corrupt' }
      })
    )

    const dialog = host.querySelector('[role="alertdialog"]')
    const reason = host.querySelector('.ix-core-failure__reason')
    const restart = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Restart Intersect'
    )
    expect(dialog).toBeTruthy()
    expect(reason?.textContent).toBe('core bootstrap failed: db is corrupt')
    expect(restart?.getAttribute('type')).toBe('button')
  })
})
