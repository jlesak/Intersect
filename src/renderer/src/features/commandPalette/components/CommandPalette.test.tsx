import { act, fireEvent, render } from '@testing-library/react'
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

  const headings = (): (string | null)[] =>
    [...document.querySelectorAll('.ix-palette__heading')].map((e) => e.textContent)

  const openWith = async (...commands: Parameters<typeof registerCommand>[0][]): Promise<void> => {
    for (const command of commands) registerCommand(command)
    await act(async () => {
      render(<CommandPalette />)
      useCommandPaletteStore.getState().toggle()
    })
  }

  const press = async (key: string): Promise<void> => {
    const input = document.querySelector('.ix-palette__input')!
    await act(async () => {
      fireEvent.keyDown(input, { key })
    })
  }

  const activeTitle = (): string | null | undefined =>
    document.querySelector('.ix-palette__item--active .ix-palette__title')?.textContent

  test('files commands under their group heading at rest', async () => {
    await openWith(
      { id: 'tabs.next', title: 'Next Tab', group: 'Tabs', handler: () => {} },
      { id: 'prInbox.sync', title: 'Sync Pull Requests', group: 'Pull Requests', handler: () => {} },
      { id: 'tabs.newShell', title: 'New Shell Tab', group: 'Tabs', handler: () => {} }
    )

    expect(headings()).toEqual(['Pull Requests', 'Tabs'])
    expect(titles()).toEqual(['Sync Pull Requests', 'Next Tab', 'New Shell Tab'])
  })

  test('drops the headings while a query is being typed, so ranking is what is shown', async () => {
    await openWith(
      { id: 'tabs.next', title: 'Next Tab', group: 'Tabs', handler: () => {} },
      { id: 'prInbox.sync', title: 'Sync Tabulator', group: 'Pull Requests', handler: () => {} }
    )

    const input = document.querySelector('.ix-palette__input')!
    await act(async () => {
      fireEvent.change(input, { target: { value: 'tab' } })
    })

    // "tab" starts a word in "Sync TABulator" and lands mid-word in "Next Tab", so the ranked
    // order is the reverse of registration order - which is only observable without headings.
    expect(headings()).toEqual([])
    expect(titles()).toEqual(['Sync Tabulator', 'Next Tab'])
  })

  test('finds a command by a keyword that is not in its title, and runs it', async () => {
    const ran: string[] = []
    await openWith({
      id: 'tabs.newShell',
      title: 'New Shell Tab',
      keywords: ['bash', 'zsh'],
      handler: () => void ran.push('shell')
    })

    const input = document.querySelector('.ix-palette__input')!
    await act(async () => {
      fireEvent.change(input, { target: { value: 'bash' } })
    })
    expect(titles()).toEqual(['New Shell Tab'])

    await press('Enter')
    expect(ran).toEqual(['shell'])
  })

  test('a command whose preconditions are unmet is listed, but Enter will not run it', async () => {
    const ran: string[] = []
    await openWith({
      id: 'tabs.close',
      title: 'Close Tab',
      enabled: () => false,
      handler: () => void ran.push('close')
    })

    // Listed, because a command that disappears when it cannot run reads as a lost command.
    expect(titles()).toEqual(['Close Tab'])
    expect(document.querySelector('.ix-palette__item')!.className).toContain(
      'ix-palette__item--disabled'
    )

    // Enter is the path a keyboard user takes, and the only one the browser does not block for
    // them: it must run nothing and leave the palette standing rather than closing on a no-op.
    await press('Enter')
    expect(ran).toEqual([])
    expect(useCommandPaletteStore.getState().open).toBe(true)
  })

  test('arrow navigation steps over an unrunnable command instead of stopping on it', async () => {
    await openWith(
      { id: 'a.one', title: 'First', handler: () => {} },
      { id: 'a.two', title: 'Second', enabled: () => false, handler: () => {} },
      { id: 'a.three', title: 'Third', handler: () => {} }
    )

    expect(activeTitle()).toBe('First')
    await press('ArrowDown')
    expect(activeTitle()).toBe('Third')
    await press('ArrowUp')
    expect(activeTitle()).toBe('First')
  })

  test('selection starts on the first runnable command, not the first row', async () => {
    const ran: string[] = []
    await openWith(
      { id: 'a.one', title: 'First', enabled: () => false, handler: () => void ran.push('first') },
      { id: 'a.two', title: 'Second', handler: () => void ran.push('second') }
    )

    expect(activeTitle()).toBe('Second')
    await press('Enter')
    expect(ran).toEqual(['second'])
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
