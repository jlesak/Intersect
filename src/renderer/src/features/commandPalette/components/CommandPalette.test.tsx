import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  __resetCommandRegistryForTests,
  registerCommand
} from '@renderer/shared/registries/commandRegistry'
import { useCommandPaletteStore } from '../store'
import { CommandPalette } from './CommandPalette'

/**
 * The palette's visibility now comes from a store rather than a key listener, and which commands it
 * lists - plus the key hint beside them - is derived from the shortcut map. All three are covered
 * here so a regression does not have to wait for a build and an end-to-end run.
 */
describe('CommandPalette', () => {
  beforeEach(() => {
    __resetCommandRegistryForTests()
    useCommandPaletteStore.setState({ open: false }, false)
  })

  afterEach(() => {
    __resetCommandRegistryForTests()
    useCommandPaletteStore.setState({ open: false }, false)
  })

  const titles = (): (string | null)[] =>
    [...document.querySelectorAll('.ix-palette__title')].map((e) => e.textContent)

  test('stays closed until the store opens it', async () => {
    registerCommand({ id: 'shell.toggleSidebar', title: 'Toggle Sidebar', handler: () => {} })

    await act(async () => {
      render(<CommandPalette />)
    })
    expect(document.querySelector('.ix-palette')).toBeNull()

    await act(async () => {
      useCommandPaletteStore.getState().toggle()
    })
    expect(document.querySelector('.ix-palette')).toBeTruthy()
    expect(titles()).toEqual(['Toggle Sidebar'])
  })

  test('shows the shortcut a command owns as a key hint', async () => {
    registerCommand({ id: 'shell.toggleSidebar', title: 'Toggle Sidebar', handler: () => {} })

    await act(async () => {
      render(<CommandPalette />)
      useCommandPaletteStore.getState().toggle()
    })

    const hint = document.querySelector('.ix-palette__item .ix-kbd')
    expect(hint?.textContent).toBe('⌘B')
  })

  test('leaves a command with no shortcut without a hint', async () => {
    registerCommand({ id: 'prInbox.sync', title: 'Sync Pull Requests', handler: () => {} })

    await act(async () => {
      render(<CommandPalette />)
      useCommandPaletteStore.getState().toggle()
    })

    expect(titles()).toEqual(['Sync Pull Requests'])
    expect(document.querySelector('.ix-palette__item .ix-kbd')).toBeNull()
  })

  // The positional tab jumps keep their accelerators but would be noise in a list you type into,
  // and the palette's own open command would close and reopen it.
  test('omits the commands the shortcut map marks hidden', async () => {
    registerCommand({ id: 'tabs.jump.4', title: 'Tab 4', handler: () => {} })
    registerCommand({ id: 'palette.open', title: 'Command Palette', handler: () => {} })
    registerCommand({ id: 'tabs.next', title: 'Next Tab', handler: () => {} })

    await act(async () => {
      render(<CommandPalette />)
      useCommandPaletteStore.getState().toggle()
    })

    expect(titles()).toEqual(['Next Tab'])
  })

  test('mounts and settles without a render loop', async () => {
    registerCommand({ id: 'tabs.next', title: 'Next Tab', handler: () => {} })
    const logged: string[] = []
    const original = console.error
    console.error = (...args: unknown[]): void => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    }
    try {
      await act(async () => {
        render(<CommandPalette />)
        useCommandPaletteStore.getState().toggle()
      })
      expect(logged).toEqual([])
    } finally {
      console.error = original
    }
  })
})
