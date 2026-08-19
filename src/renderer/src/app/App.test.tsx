import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  __resetSidebarRegistryForTests,
  registerSidebarSection
} from '@renderer/shared/registries/sidebarRegistry'
import { App } from './App'
import { useShellStore } from './shellStore'

const Icon = () => <span />

function Healthy() {
  return <div className="ix-main ix-probe-healthy">healthy section</div>
}

function Crashing(): never {
  throw new Error('section render failed')
}

/**
 * The app shell around a crashing section: the whole point of the region boundary is that a broken
 * feature costs the user only the content area, never the navigation that gets them out of it.
 */
describe('App shell containment of a crashing main region', () => {
  beforeEach(() => {
    __resetSidebarRegistryForTests()
    registerSidebarSection({ id: 'healthy', order: 0, label: 'Healthy', icon: Icon, mainComponent: Healthy })
    registerSidebarSection({ id: 'broken', order: 1, label: 'Broken', icon: Icon, mainComponent: Crashing })
    // CoreStatusOverlay subscribes on mount; the rest of the shell only reads store defaults.
    ;(window as { intersect?: unknown }).intersect = {
      system: { onCoreStatus: () => () => {} }
    }
    useShellStore.setState({ context: { kind: 'section', id: 'broken' }, sidebarCollapsed: false })
  })

  afterEach(() => {
    __resetSidebarRegistryForTests()
    delete (window as { intersect?: unknown }).intersect
    useShellStore.setState({ context: null, sidebarCollapsed: false })
  })

  test('the crash is contained to the main region while the sidebar stays live', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(<App />)

      expect(document.querySelector('.ix-crash--region')).toBeTruthy()
      expect(document.querySelector('.ix-crash__reason')?.textContent).toBe('section render failed')
      // The navigation the user needs to escape with is untouched.
      const railLabels = [...document.querySelectorAll('.ix-rail__label')].map((e) => e.textContent)
      expect(railLabels).toContain('Healthy')
      expect(railLabels).toContain('Broken')
      // And the fallback points at that sidebar by name, because here it is what survived.
      expect(document.querySelector('.ix-crash__card')?.textContent).toContain(
        'Pick another project or section in the sidebar'
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  test('navigating to another context clears the fallback and mounts the new view', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(<App />)
      expect(document.querySelector('.ix-crash--region')).toBeTruthy()

      act(() => {
        useShellStore.getState().setActiveSection('healthy')
      })

      expect(document.querySelector('.ix-crash--region')).toBeNull()
      expect(document.querySelector('.ix-probe-healthy')?.textContent).toBe('healthy section')
    } finally {
      consoleError.mockRestore()
    }
  })
})
