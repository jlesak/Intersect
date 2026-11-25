import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { TimeEntry } from '@common/domain'
import { useSessionsStore } from '@renderer/features/sessions'
import { useProjectsStore } from '@renderer/features/projects'
import { useTimeTrackingStore } from '../store'
import { EntryCard } from './EntryCard'

const ENTRY: TimeEntry = {
  id: 's1',
  source: 'auto',
  sessionId: 's1', cwd: '/work', resumable: true, firstTimestamp: 1, lastTimestamp: 2,
  day: '2026-07-06',
  description: 'Fix the login redirect',
  issueKey: 'PROJ-611',
  durationMs: 60 * 60_000
}

let host: HTMLDivElement
let root: Root
const updateEntry = vi.fn(() => Promise.resolve())

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  useTimeTrackingStore.setState({ updateEntry })
  useSessionsStore.setState({ pendingResume: null })
  useProjectsStore.setState({ projects: [] })
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
      issueKey: 'PROJ-611',
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
      issueKey: 'PROJ-611',
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


test('a background snapshot update preserves a dirty description draft', () => {
  render()
  type(field('Description'), 'My unfinished draft')
  render({ ...ENTRY, description: 'New automatic title' })
  expect(field('Description').value).toBe('My unfinished draft')
})

test('auto cards show no session metadata or source marker', () => {
  const legacyMetadata = { ...ENTRY, sessionTitle: 'Private session title',
    folderName: 'private-folder', gitBranch: 'feature/private-branch', cwd: '/work/search' }
  render(legacyMetadata)
  for (const detail of ['Private session title', 'private-folder', 'feature/private-branch',
    '/work/search']) expect(host.outerHTML).not.toContain(detail)
  expect(host.querySelector('.ix-tt-card__metadata')).toBeNull()
  expect(host.querySelector('[title="Automatic from Claude Code"]')).toBeNull()
  expect(field('Description').value).toBe(ENTRY.description)
})


test('focused untouched duration follows new measurement on blur without creating an override', () => {
  render()
  const input = field('Time spent')
  act(() => input.focus())
  render({ ...ENTRY, durationMs: 2 * 60 * 60000 })
  blur(input)
  expect(updateEntry).not.toHaveBeenCalled()
  expect(input.value).toBe('2h 0m')
})

test('editing only description preserves the exact measured milliseconds', () => {
  render({ ...ENTRY, durationMs: 300001 })
  type(field('Description'), 'Exact milliseconds')
  blur(field('Description'))
  expect(updateEntry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ durationMs: 300001 }))
})


test('only resumable auto cards offer Resume', () => {
  render(ENTRY)
  expect(host.querySelector('button[title="Resume"]')).not.toBeNull()
  render({ ...ENTRY, resumable: false })
  expect(host.querySelector('button[title="Resume"]')).toBeNull()
  render({ id: 'manual', source: 'manual', day: ENTRY.day, description: 'Meeting', issueKey: null, durationMs: 60000 })
  expect(host.querySelector('button[title="Resume"]')).toBeNull()
})

test('Resume immediately after a description edit uses the current draft', () => {
  render()
  const description = field('Description')
  type(description, 'Fresh card title')
  blur(description)
  act(() => (host.querySelector('button[title="Resume"]') as HTMLButtonElement).click())
  expect(useSessionsStore.getState().pendingResume).toEqual({
    id: 's1', cwd: '/work', title: 'Fresh card title', origin: 'card'
  })
})

test.each(['Issue key', 'Time spent'])('background updates preserve a dirty %s until Escape', label => {
  render()
  type(field(label), label === 'Issue key' ? 'NEW-123' : '3h')
  render({ ...ENTRY, issueKey: 'SERVER-1', durationMs: 120000 })
  expect(field(label).value).toBe(label === 'Issue key' ? 'NEW-123' : '3h')
  press(field(label), 'Escape')
  expect(field(label).value).toBe(label === 'Issue key' ? 'SERVER-1' : '2m')
  expect(updateEntry).not.toHaveBeenCalled()
})

test('an accepted project-only meeting card shows the project name and falls back after deletion', () => {
  const routed: TimeEntry = { id: 'meeting', source: 'manual', day: ENTRY.day,
    description: 'Planning', issueKey: null, projectId: 'p1', durationMs: 1800000 }
  useProjectsStore.setState({ projects: [{ id: 'p1', name: 'Build', sortOrder: 0,
    archived: false, repoPaths: ['/work/build'], jiraJql: null, jiraBoardUrl: null,
    adoRepositories: [] }] })
  render(routed)
  expect(host.querySelector('.ix-tt-card__project')?.textContent).toBe('Build')
  act(() => useProjectsStore.setState({ projects: [] }))
  expect(host.querySelector('.ix-tt-card__project')?.textContent).toBe('Other')
})

test('a project meeting card follows an edited issue key, then its stored project when cleared', () => {
  const routed: TimeEntry = { id: 'meeting', source: 'manual', day: ENTRY.day,
    description: 'Planning', issueKey: null, projectId: 'p1', durationMs: 1800000 }
  useProjectsStore.setState({ projects: [
    { id: 'p1', name: 'Build', sortOrder: 0, archived: false, repoPaths: [],
      jiraJql: 'project = BUILD', jiraBoardUrl: null, adoRepositories: [] },
    { id: 'p2', name: 'Platform', sortOrder: 1, archived: false, repoPaths: [],
      jiraJql: 'project = PLAT', jiraBoardUrl: null, adoRepositories: [] }
  ] })
  render(routed)
  expect(host.querySelector('.ix-tt-card__project')?.textContent).toBe('Build')
  type(field('Issue key'), 'PLAT-7')
  blur(field('Issue key'))
  render({ ...routed, issueKey: 'PLAT-7' })
  expect(host.querySelector('.ix-tt-card__project')?.textContent).toBe('Platform')
  type(field('Issue key'), '')
  blur(field('Issue key'))
  render(routed)
  expect(host.querySelector('.ix-tt-card__project')?.textContent).toBe('Build')
})
