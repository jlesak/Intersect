import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  __resetCaptureRegistryForTests,
  registerCapture
} from '@renderer/shared/registries/captureRegistry'
import {
  __resetCommandRegistryForTests,
  registerCommand,
  registerCommandProvider
} from '@renderer/shared/registries/commandRegistry'
vi.mock('../ipc')
import * as paletteApi from '../ipc'
import { useCommandPaletteStore } from '../store'
import { CommandPalette } from './CommandPalette'

const mocked = vi.mocked(paletteApi)

/**
 * The palette's visibility now comes from a store rather than a key listener, and which commands it
 * lists - plus the key hint beside them - is derived from the shortcut map. All three are covered
 * here so a regression does not have to wait for a build and an end-to-end run.
 */
describe('CommandPalette', () => {
  beforeEach(() => {
    __resetCommandRegistryForTests()
    __resetCaptureRegistryForTests()
    useCommandPaletteStore.setState({ open: false, recentIds: [] }, false)
    vi.clearAllMocks()
    mocked.recordUse.mockResolvedValue([])
  })

  afterEach(() => {
    __resetCommandRegistryForTests()
    __resetCaptureRegistryForTests()
    useCommandPaletteStore.setState({ open: false, recentIds: [] }, false)
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

  const type = async (value: string): Promise<void> => {
    const input = document.querySelector('.ix-palette__input')!
    await act(async () => {
      fireEvent.change(input, { target: { value } })
    })
  }

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
      { id: 'prInbox.sync', title: 'Tabulator Sync', group: 'Pull Requests', handler: () => {} }
    )

    const input = document.querySelector('.ix-palette__input')!
    await act(async () => {
      fireEvent.change(input, { target: { value: 'tab' } })
    })

    // "tab" opens "TABulator Sync" and only reaches the last word of "Next Tab", so the ranked
    // order is the reverse of registration order - which is only observable without headings.
    expect(headings()).toEqual([])
    expect(titles()).toEqual(['Tabulator Sync', 'Next Tab'])
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

  test('the selection lands on a runnable row even when a group above it is entirely dead', async () => {
    const ran: string[] = []
    await openWith(
      { id: 'a.one', title: 'Alpha', group: 'Alpha', enabled: () => false, handler: () => {} },
      { id: 'b.one', title: 'Bravo', group: 'Bravo', handler: () => void ran.push('bravo') }
    )

    expect(activeTitle()).toBe('Bravo')
    await press('Enter')
    expect(ran).toEqual(['bravo'])
  })

  // The rendered order is grouped while the selection is an index into one flat list. If the two
  // ever disagree, Enter runs a different command from the one highlighted - which no assertion
  // about the highlight alone can catch.
  test('Enter runs the row that is highlighted, across group boundaries', async () => {
    const ran: string[] = []
    await openWith(
      { id: 'z.one', title: 'Zulu One', group: 'Zulu', handler: () => void ran.push('zulu-one') },
      { id: 'a.one', title: 'Alpha One', group: 'Alpha', handler: () => void ran.push('alpha-one') },
      { id: 'z.two', title: 'Zulu Two', group: 'Zulu', handler: () => void ran.push('zulu-two') }
    )

    // Alphabetical groups put Alpha first, so the rendered order is Alpha One, Zulu One, Zulu Two.
    expect(titles()).toEqual(['Alpha One', 'Zulu One', 'Zulu Two'])

    await press('ArrowDown')
    expect(activeTitle()).toBe('Zulu One')
    await press('ArrowDown')
    expect(activeTitle()).toBe('Zulu Two')
    await press('Enter')
    expect(ran).toEqual(['zulu-two'])
  })

  test('the recently used commands really are the ones the store remembers', async () => {
    useCommandPaletteStore.setState({ recentIds: ['b.one'] }, false)
    await openWith(
      { id: 'a.one', title: 'Alpha', group: 'Alpha', handler: () => {} },
      { id: 'b.one', title: 'Bravo', group: 'Bravo', handler: () => {} }
    )

    expect(headings()).toEqual(['Recent', 'Alpha'])
    expect(titles()).toEqual(['Bravo', 'Alpha'])
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

  describe('state-derived targets', () => {
    test('a provider contributes rows the registry never held', async () => {
      const opened: string[] = []
      registerCommandProvider(() => [
        { id: 'workspaces.goto.w1', title: 'Switch to workspace: api', handler: () => void opened.push('w1') }
      ])
      await openWith({ id: 'tabs.next', title: 'Next Tab', handler: () => {} })

      await type('workspace api')
      expect(titles()).toEqual(['Switch to workspace: api'])
      await press('Enter')
      expect(opened).toEqual(['w1'])
    })

    test('a provider is asked about the query it should answer', async () => {
      const asked: string[] = []
      registerCommandProvider((query) => {
        asked.push(query)
        return query.length < 2 ? [] : [{ id: 'x.1', title: 'Late Target', handler: () => {} }]
      })
      await openWith({ id: 'tabs.next', title: 'Next Tab', handler: () => {} })

      expect(titles()).toEqual(['Next Tab'])
      await type('la')
      expect(titles()).toEqual(['Late Target'])
      expect(asked).toContain('la')
    })

    test('running a derived target does not enter the recently-used list', async () => {
      registerCommandProvider(() => [
        { id: 'sessions.resume.abc', title: 'Resume session: fix the parser', handler: () => {} }
      ])
      await openWith({ id: 'tabs.next', title: 'Next Tab', handler: () => {} })

      await type('resume fix')
      await press('Enter')
      expect(mocked.recordUse).not.toHaveBeenCalled()
    })

    test('running a registered command does enter the recently-used list', async () => {
      await openWith({ id: 'tabs.next', title: 'Next Tab', handler: () => {} })
      await press('Enter')
      expect(mocked.recordUse).toHaveBeenCalledWith('tabs.next')
    })
  })

  describe('quick capture', () => {
    const captured: string[] = []

    beforeEach(() => {
      captured.length = 0
      registerCapture({
        prefix: 'todo:',
        hint: 'Add a task',
        preview: (rest) => (rest === '' ? null : `Add task "${rest}"`),
        run: (rest) => void captured.push(rest)
      })
    })

    test('the prefix alone shows the capture hint and lists no commands', async () => {
      await openWith({ id: 'tabs.next', title: 'Next Tab', handler: () => {} })
      await type('todo:')

      expect(document.querySelector('.ix-palette__capture-hint')?.textContent).toBe('Add a task')
      expect(titles()).toEqual([])
    })

    test('Enter on the prefix alone captures nothing and leaves the palette open', async () => {
      await openWith({ id: 'tabs.next', title: 'Next Tab', handler: () => {} })
      await type('todo:')
      await press('Enter')

      expect(captured).toEqual([])
      expect(useCommandPaletteStore.getState().open).toBe(true)
    })

    test('text after the prefix previews what would happen, and Enter does it', async () => {
      await openWith({ id: 'tabs.next', title: 'Next Tab', handler: () => {} })
      await type('todo: call the vendor tomorrow')

      expect(titles()).toEqual(['Add task "call the vendor tomorrow"'])

      await press('Enter')
      expect(captured).toEqual(['call the vendor tomorrow'])
      expect(useCommandPaletteStore.getState().open).toBe(false)
    })

    test('a capture query never runs a command that happens to match its text', async () => {
      const ran: string[] = []
      await openWith({ id: 'tabs.next', title: 'todo next', handler: () => void ran.push('cmd') })
      await type('todo: next')
      await press('Enter')

      expect(ran).toEqual([])
      expect(captured).toEqual(['next'])
    })

    test('clicking the previewed capture runs it too', async () => {
      await openWith({ id: 'tabs.next', title: 'Next Tab', handler: () => {} })
      await type('todo: buy milk')
      await act(async () => {
        fireEvent.click(document.querySelector('.ix-palette__capture .ix-palette__item')!)
      })

      expect(captured).toEqual(['buy milk'])
    })

    test('the registered prefixes are advertised so the syntax is findable', async () => {
      await openWith({ id: 'tabs.next', title: 'Next Tab', handler: () => {} })
      expect(document.querySelector('.ix-palette__prefixes')?.textContent).toContain('todo:')
    })

    test('backing out of the prefix returns to searching commands', async () => {
      await openWith({ id: 'tabs.next', title: 'Next Tab', handler: () => {} })
      await type('todo: x')
      expect(titles()).toEqual(['Add task "x"'])

      await type('next')
      expect(titles()).toEqual(['Next Tab'])
    })
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
