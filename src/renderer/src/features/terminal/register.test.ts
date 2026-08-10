import { beforeEach, describe, expect, test, vi } from 'vitest'
import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from '@common/domain'

// The settings store persists through the preload bridge; the fake is what proves a single
// keypress reached SQLite instead of sitting in the store's debounce.
const setTerminalFontSize = vi.hoisted(() => vi.fn(() => Promise.resolve({})))
vi.mock('@renderer/shared/ipc/client', () => ({
  ipc: () => ({ settings: { setTerminalFontSize } })
}))

import { useSettingsStore } from '@renderer/features/settings'
import {
  __resetCommandRegistryForTests,
  getCommand
} from '@renderer/shared/registries/commandRegistry'
import { useFindStore } from './findStore'
import { registerTerminalFeature } from './register'

const run = (id: string): void => {
  void getCommand(id)!.handler()
}

const fontSize = (): number => useSettingsStore.getState().terminalFontSize

beforeEach(() => {
  __resetCommandRegistryForTests()
  vi.clearAllMocks()
  useSettingsStore.setState({ terminalFontSize: 12.5 })
  useFindStore.setState({ open: {}, query: {}, focusToken: {} })
  document.body.innerHTML = ''
  registerTerminalFeature()
})

describe('the terminal font zoom commands', () => {
  test('each one is filed under Terminal so the palette groups them together', () => {
    for (const id of ['terminal.fontIncrease', 'terminal.fontDecrease', 'terminal.fontReset']) {
      expect(getCommand(id)?.group).toBe('Terminal')
    }
  })

  test('increase moves the size the settings slider shows', () => {
    run('terminal.fontIncrease')
    expect(fontSize()).toBe(13.5)
  })

  test('decrease moves the size the settings slider shows', () => {
    run('terminal.fontDecrease')
    expect(fontSize()).toBe(11.5)
  })

  test('reset returns to the size a fresh install starts with', () => {
    useSettingsStore.setState({ terminalFontSize: 18 })
    run('terminal.fontReset')
    expect(fontSize()).toBe(12.5)
  })

  test('holding the key down never pushes the size past what the slider allows', () => {
    for (let i = 0; i < 40; i += 1) run('terminal.fontIncrease')
    expect(fontSize()).toBe(TERMINAL_FONT_SIZE_MAX)

    for (let i = 0; i < 40; i += 1) run('terminal.fontDecrease')
    expect(fontSize()).toBe(TERMINAL_FONT_SIZE_MIN)
  })

  test('a single press is written out at once, so the size survives a quit', () => {
    run('terminal.fontIncrease')
    expect(setTerminalFontSize).toHaveBeenCalledWith(13.5)
  })
})

describe('the find command', () => {
  /** A stage holding one terminal pane, as the split stage renders it. */
  function stage(sessionId: string): void {
    document.body.innerHTML = `<div class="ix-stage"><div class="ix-pane"><div class="ix-pane__host" data-session-id="${sessionId}"></div></div></div>`
  }

  test('it is how a user finds out the key exists at all, filed with the other terminal commands', () => {
    expect(getCommand('terminal.find')?.group).toBe('Terminal')
  })

  test('running it opens the bar on the terminal that is on screen', () => {
    stage('ws1:tab7')

    run('terminal.find')

    expect(useFindStore.getState().open['ws1:tab7']).toBe(true)
  })

  test('with no terminal on screen it stays listed but will not run', () => {
    document.body.innerHTML = ''

    expect(getCommand('terminal.find')?.enabled?.()).toBe(false)
    expect(() => run('terminal.find')).not.toThrow()
    expect(useFindStore.getState().open).toEqual({})
  })
})
