import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { TimeEntry } from '@common/domain'

vi.stubGlobal('React', React)

import { useTimeTrackingStore } from '../store'
import { EntryCard } from './EntryCard'

const ENTRY: TimeEntry = {
  id: 's1',
  source: 'auto',
  day: '2026-07-06',
  description: 'Fix the login redirect',
  issueKey: 'FID2507-611',
  durationMs: 60 * 60_000
}

let host: HTMLDivElement
let root: Root
const updateEntry = vi.fn(() => Promise.resolve())

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  useTimeTrackingStore.setState({ updateEntry })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(entry: TimeEntry = ENTRY): void {
  act(() => root.render(React.createElement(EntryCard, { entry })))
}

const field = (label: string): HTMLInputElement =>
  host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement

/** Set an input's value the way React tracks it, then fire the change React listens for. */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    input.focus()
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const blur = (input: HTMLInputElement): void => {
  act(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
}

const press = (input: HTMLInputElement, key: string): void => {
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
}

describe('EntryCard description editing', () => {
  test('renders the entry description in the input', () => {
    render()
    expect(field('Description').value).toBe('Fix the login redirect')
  })

  test('typing then blurring commits the full update payload', () => {
    render()
    const input = field('Description')
    type(input, 'Fix the logout flow')
    blur(input)
    expect(updateEntry).toHaveBeenCalledWith(ENTRY, {
      description: 'Fix the logout flow',
      issueKey: 'FID2507-611',
      durationMs: 60 * 60_000
    })
  })

  test('Enter commits exactly once', () => {
    render()
    const input = field('Description')
    type(input, 'Refactor the parser')
    press(input, 'Enter')
    expect(updateEntry).toHaveBeenCalledTimes(1)
    expect(updateEntry).toHaveBeenCalledWith(ENTRY, {
      description: 'Refactor the parser',
      issueKey: 'FID2507-611',
      durationMs: 60 * 60_000
    })
  })

  test('Escape reverts the draft without committing', () => {
    render()
    const input = field('Description')
    type(input, 'discard me')
    press(input, 'Escape')
    expect(updateEntry).not.toHaveBeenCalled()
    expect(input.value).toBe('Fix the login redirect')
  })

  test('an emptied description reverts without committing', () => {
    render()
    const input = field('Description')
    type(input, '   ')
    blur(input)
    expect(updateEntry).not.toHaveBeenCalled()
    expect(input.value).toBe('Fix the login redirect')
  })

  test('focusing and blurring untouched description or duration commits nothing', () => {
    render()
    blur(field('Description'))
    blur(field('Time spent'))
    expect(updateEntry).not.toHaveBeenCalled()
  })

  test('a second edit carries the first edit even before a store reload', () => {
    render()
    const keyInput = field('Issue key')
    type(keyInput, 'ab-9')
    blur(keyInput)
    // No reload happened, so the entry prop still shows the old issue key; the description commit
    // must assemble its payload from the live drafts, not the stale prop.
    const descInput = field('Description')
    type(descInput, 'Ship the fix')
    blur(descInput)
    expect(updateEntry).toHaveBeenLastCalledWith(ENTRY, {
      description: 'Ship the fix',
      issueKey: 'AB-9',
      durationMs: 60 * 60_000
    })
  })

  test('editing the issue key carries the description in its payload', () => {
    render()
    const input = field('Issue key')
    type(input, 'ab-9')
    blur(input)
    expect(updateEntry).toHaveBeenCalledWith(ENTRY, {
      description: 'Fix the login redirect',
      issueKey: 'AB-9',
      durationMs: 60 * 60_000
    })
  })
})
