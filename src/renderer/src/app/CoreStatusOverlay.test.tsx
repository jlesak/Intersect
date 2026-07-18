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

  test('a restarting core shows the attempt and reason without any action buttons', () => {
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(
      React.createElement(CoreStatusOverlay, {
        initialStatus: { state: 'restarting', message: 'core process exited unexpectedly (code 9)', attempt: 2 }
      })
    )

    const dialog = host.querySelector('[role="alertdialog"]')
    expect(dialog).toBeTruthy()
    expect(host.querySelector('h1')?.textContent).toContain('(attempt 2)')
    expect(host.querySelector('.ix-core-failure__reason')?.textContent).toBe(
      'core process exited unexpectedly (code 9)'
    )
    expect(host.querySelectorAll('button')).toHaveLength(0)
  })

  test('a failed core shows the reason with retry, quit, and relaunch actions', () => {
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(
      React.createElement(CoreStatusOverlay, {
        initialStatus: { state: 'failed', message: 'core bootstrap failed: db is corrupt' }
      })
    )

    const dialog = host.querySelector('[role="alertdialog"]')
    const reason = host.querySelector('.ix-core-failure__reason')
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent)
    expect(dialog).toBeTruthy()
    expect(reason?.textContent).toBe('core bootstrap failed: db is corrupt')
    expect(labels).toEqual(['Retry', 'Quit Intersect', 'Restart Intersect'])
    for (const button of host.querySelectorAll('button')) {
      expect(button.getAttribute('type')).toBe('button')
    }
  })
})
