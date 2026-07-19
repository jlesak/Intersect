import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { DEFAULT_PR_REVIEW_PROMPT } from '@common/domain'
import { SettingsView } from './SettingsView'

// Vitest transforms TSX without the renderer's Vite React plugin, so provide its classic JSX
// runtime explicitly for the imported production component.
vi.stubGlobal('React', React)

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
