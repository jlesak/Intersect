import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SuspendStatus } from '@common/domain'

// The terminal controller owns xterm/PTY side effects; mock its surface so the test asserts
// whether a spawn was even attempted, without booting a real terminal.
const controllerMock = vi.hoisted(() => ({
  ensureSession: vi.fn(() => Promise.resolve()),
  attachSession: vi.fn(),
  detachSession: vi.fn(),
  respawnInterrupted: vi.fn(() => Promise.resolve()),
  findInSession: vi.fn(() => true),
  clearSessionSearch: vi.fn(),
  focusSession: vi.fn(),
  onSessionSearchResults: vi.fn(() => () => {})
}))
vi.mock('../terminalController', () => controllerMock)

const clearSuspended = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('@renderer/shared/ipc/client', () => ({
  ipc: () => ({ sessions: { clearSuspended } })
}))

import { useFindStore } from '../findStore'
import { useInterruptedStore } from '../interruptedStore'
import { useSettingsStore } from '@renderer/features/settings'
import { TerminalPane } from './TerminalPane'

const SID = 'ws1:tab1'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  useInterruptedStore.setState({ interrupted: {} })
  useFindStore.setState({ open: {}, query: {}, focusToken: {} })
  useSettingsStore.setState({ autoResume: true })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(sessionStatus: SuspendStatus | null, resumeSessionId: string | null = 'uuid-1'): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(TerminalPane, {
        sessionId: SID,
        preset: 'claude',
        cwd: '/repo',
        resumeSessionId,
        sessionStatus
      })
    )
  })
}

describe('TerminalPane suspend/resume recovery', () => {
  test('an ordinary tab (no suspend marker) spawns normally', async () => {
    await render(null)
    expect(controllerMock.ensureSession).toHaveBeenCalledWith(SID, 'claude', '/repo', 'uuid-1')
  })

  test('a suspended tab auto-resumes when the setting is on, and clears the marker', async () => {
    useSettingsStore.setState({ autoResume: true })
    await render('suspended')
    expect(controllerMock.ensureSession).toHaveBeenCalledWith(SID, 'claude', '/repo', 'uuid-1')
    // The respawn is a NEW process: the durable marker is cleared and a restored note is shown.
    expect(clearSuspended).toHaveBeenCalledWith('tab1')
    expect(host.textContent).toContain('Obnoveno po ukončení - toto je nový terminál')
  })

  test('a suspended tab with auto-resume OFF never spawns and offers a manual Resume', async () => {
    useSettingsStore.setState({ autoResume: false })
    await render('suspended')
    expect(controllerMock.ensureSession).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Session byla pozastavena při ukončení')
    const resume = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Obnovit Claude session')
    )
    expect(resume).toBeTruthy()

    // Clicking Resume flips it into a real spawn (a terminating progression, never a loop).
    await act(async () => {
      resume?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(controllerMock.ensureSession).toHaveBeenCalledWith(SID, 'claude', '/repo', 'uuid-1')
  })

  test('a resume-failed tab never auto-spawns and offers the three recovery actions', async () => {
    await render('resume-failed')
    expect(controllerMock.ensureSession).not.toHaveBeenCalled()
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(labels).toEqual(
      expect.arrayContaining(['Spustit novou session', 'Vybrat složku', 'Archivovat'])
    )
  })

  test('the resume-failed wording is distinct from the crash-interrupted wording', async () => {
    await render('resume-failed')
    expect(host.textContent).toContain('Session se nepodařilo obnovit')
    expect(host.textContent).not.toContain('the process did not survive')
  })

  test('"Start a new session" on a resume-failed tab spawns fresh, without the stored resume id', async () => {
    await render('resume-failed')
    const fresh = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Spustit novou session'
    )
    await act(async () => {
      fresh?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(controllerMock.ensureSession).toHaveBeenCalledWith(SID, 'claude', '/repo', null)
  })
})

describe('TerminalPane find bar', () => {
  test('the pane names the session it hosts, so a keystroke can be aimed at it', async () => {
    await render(null)
    expect(host.querySelector('.ix-pane__host')?.getAttribute('data-session-id')).toBe(SID)
  })

  test('no bar until this very session is asked for one', async () => {
    useFindStore.setState({ open: { 'ws1:other': true } })
    await render(null)

    expect(host.querySelector('.ix-find')).toBeNull()

    await act(async () => {
      useFindStore.getState().openFind(SID)
    })
    expect(host.querySelector('.ix-find')).not.toBeNull()
  })

  test('a pane waiting on a recovery decision claims no session and offers no bar', async () => {
    useFindStore.setState({ open: { [SID]: true } })

    // Nothing has spawned here: the pane is showing the "session could not be resumed" choices,
    // so there is no terminal for a search to run against.
    await render('resume-failed')

    expect(host.querySelector('.ix-pane__host')?.getAttribute('data-session-id')).toBeNull()
    expect(host.querySelector('.ix-find')).toBeNull()
  })
})
