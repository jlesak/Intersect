import { act, render as renderClient } from '@testing-library/react'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_PR_REVIEW_PROMPT,
  type AppSettings,
  type EffectiveConfig
} from '@common/domain'
import { SettingsView } from './SettingsView'

describe('SettingsView PR Review pane', () => {
  test('renders an accessible multiline prompt editor and reset action', () => {
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(React.createElement(SettingsView))

    const navButton = [...host.querySelectorAll('.ix-settings__nav-btn')].find(
      (button) => button.textContent === 'PR Review'
    )
    const label = host.querySelector('label[for="ix-set-review-prompt"]')
    const textarea = host.querySelector<HTMLTextAreaElement>('#ix-set-review-prompt')
    const reset = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Obnovit výchozí prompt'
    )

    expect(navButton).toBeTruthy()
    expect(label?.textContent).toBe('Prompt pro AI review')
    expect(textarea?.getAttribute('aria-describedby')).toBe('ix-set-review-prompt-hint')
    expect(textarea?.value).toBe(DEFAULT_PR_REVIEW_PROMPT)
    expect(reset?.getAttribute('type')).toBe('button')
  })

  test('exposes a Sessions category with the auto-resume toggle', () => {
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(React.createElement(SettingsView))

    const navButton = [...host.querySelectorAll('.ix-settings__nav-btn')].find(
      (button) => button.textContent === 'Sessions'
    )
    const toggle = host.querySelector(
      'input[aria-label="Automaticky obnovit sessions po ukončení"]'
    )
    expect(navButton).toBeTruthy()
    expect(toggle).toBeTruthy()
  })
})

const SETTINGS: AppSettings = {
  notifications: { enabled: true, working: false, waiting: true, done: true, sound: true },
  ado: { orgUrl: '', project: '', repository: '', pat: '' },
  adoFallback: { orgUrl: '', project: '', hasPat: false },
  appearance: { terminalFontSize: 12.5 },
  review: { prompt: DEFAULT_PR_REVIEW_PROMPT },
  session: { autoResume: true }
}

const EMPTY_CONFIG: EffectiveConfig = {
  scope: { kind: 'global' },
  adapter: 'claude-code',
  files: [],
  permissions: [],
  hooks: [],
  mcpServers: [],
  advanced: []
}

/**
 * Settings keeps every category's pane mounted at once, so opening the section runs each pane's
 * container. A client render is the only gate that catches a pane whose store subscription or
 * mount effect destabilises the tree - static markup cannot see it.
 */
describe('SettingsView mounted client-side', () => {
  afterEach(() => {
    delete (window as { intersect?: unknown }).intersect
  })

  test('mounts every category pane without a render loop or logged error', async () => {
    ;(window as { intersect?: unknown }).intersect = {
      settings: { get: () => Promise.resolve(SETTINGS) },
      projects: { list: () => Promise.resolve([]), listOverrides: () => Promise.resolve([]) },
      agentTooling: {
        getEffectiveConfig: () => Promise.resolve(EMPTY_CONFIG),
        listSkills: () => Promise.resolve([]),
        listAgents: () => Promise.resolve([])
      }
    }
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })

    try {
      await act(async () => {
        renderClient(<SettingsView />)
      })

      expect(logged).toEqual([])
      expect(document.querySelector('.ix-settings')).toBeTruthy()
      expect(document.querySelectorAll('.ix-settings__pane').length).toBe(8)
      expect(document.querySelectorAll('.ix-settings__nav-btn').length).toBe(8)
      // Each pane rendered its own heading, so none of them bailed out.
      expect(document.querySelectorAll('.ix-settings__title').length).toBe(8)
    } finally {
      consoleError.mockRestore()
    }
  })
})
