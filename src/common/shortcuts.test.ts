import { describe, expect, test } from 'vitest'
import {
  formatAccelerator,
  SHORTCUT_ACTIONS,
  shortcutActionFor,
  type ShortcutMenu
} from './shortcuts'

const MENUS: ShortcutMenu[] = ['file', 'view', 'window']

describe('SHORTCUT_ACTIONS', () => {
  test('every action id is unique', () => {
    const ids = SHORTCUT_ACTIONS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('no two actions claim the same accelerator', () => {
    const counts = new Map<string, number>()
    for (const action of SHORTCUT_ACTIONS) {
      counts.set(action.accelerator, (counts.get(action.accelerator) ?? 0) + 1)
    }
    const collisions = [...counts]
      .filter(([, count]) => count > 1)
      .map(([accelerator]) => accelerator)
    expect(collisions).toEqual([])
  })

  test('every action names a real menu bucket', () => {
    for (const action of SHORTCUT_ACTIONS) {
      expect(MENUS).toContain(action.menu)
    }
  })

  test('every action carries a non-empty label', () => {
    for (const action of SHORTCUT_ACTIONS) {
      expect(action.label.trim().length).toBeGreaterThan(0)
    }
  })

  test('the nine positional tab jumps exist and stay out of the palette', () => {
    for (let n = 1; n <= 9; n++) {
      const action = SHORTCUT_ACTIONS.find((a) => a.id === `tabs.jump.${n}`)
      expect(action).toMatchObject({
        label: `Tab ${n}`,
        accelerator: `CmdOrCtrl+${n}`,
        menu: 'window',
        hidden: true
      })
    }
  })

  test('the named actions from the approved map are present', () => {
    const map = new Map(SHORTCUT_ACTIONS.map((a) => [a.id, a]))
    expect(map.get('tabs.new')).toMatchObject({ accelerator: 'CmdOrCtrl+T', menu: 'file' })
    expect(map.get('tabs.newWithPreset')).toMatchObject({
      accelerator: 'CmdOrCtrl+Shift+T',
      menu: 'file'
    })
    expect(map.get('tabs.close')).toMatchObject({ accelerator: 'CmdOrCtrl+W', menu: 'file' })
    expect(map.get('tabs.next')).toMatchObject({ accelerator: 'Control+Tab', menu: 'window' })
    expect(map.get('shell.toggleSidebar')).toMatchObject({
      accelerator: 'CmdOrCtrl+B',
      menu: 'view'
    })
    expect(map.get('projects.next')).toMatchObject({
      accelerator: 'CmdOrCtrl+Shift+P',
      menu: 'view'
    })
    expect(map.get('attention.jumpOldestWaiting')).toMatchObject({
      accelerator: 'CmdOrCtrl+Shift+A',
      menu: 'view'
    })
    expect(map.get('palette.open')).toMatchObject({ accelerator: 'CmdOrCtrl+K', menu: 'view' })
  })
})

describe('shortcutActionFor', () => {
  test('finds the action a command id owns', () => {
    expect(shortcutActionFor('tabs.close')).toMatchObject({
      label: 'Close Tab',
      accelerator: 'CmdOrCtrl+W'
    })
    expect(shortcutActionFor('tabs.jump.4')).toMatchObject({ label: 'Tab 4', hidden: true })
  })

  test('a command with no shortcut is simply undefined', () => {
    expect(shortcutActionFor('terminal.layoutGrid')).toBeUndefined()
    expect(shortcutActionFor('')).toBeUndefined()
  })
})

describe('formatAccelerator', () => {
  test('renders a bare command chord', () => {
    expect(formatAccelerator('CmdOrCtrl+K')).toBe('⌘K')
  })

  test('orders modifiers the macOS way', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+T')).toBe('⇧⌘T')
    expect(formatAccelerator('Shift+CmdOrCtrl+T')).toBe('⇧⌘T')
    expect(formatAccelerator('CmdOrCtrl+Alt+Shift+Control+P')).toBe('⌃⌥⇧⌘P')
  })

  test('keeps Control distinct from Command', () => {
    expect(formatAccelerator('Control+Tab')).toBe('⌃⇥')
  })

  test('renders digits as themselves', () => {
    expect(formatAccelerator('CmdOrCtrl+1')).toBe('⌘1')
    expect(formatAccelerator('CmdOrCtrl+9')).toBe('⌘9')
  })

  test('uppercases a single character and leaves named keys alone', () => {
    expect(formatAccelerator('CmdOrCtrl+b')).toBe('⌘B')
    expect(formatAccelerator('CmdOrCtrl+F5')).toBe('⌘F5')
  })

  test('renders every action in the map without leaking a modifier word', () => {
    for (const action of SHORTCUT_ACTIONS) {
      const shown = formatAccelerator(action.accelerator)
      expect(shown).not.toContain('+')
      expect(shown.toLowerCase()).not.toContain('cmd')
      expect(shown.toLowerCase()).not.toContain('ctrl')
      expect(shown.toLowerCase()).not.toContain('shift')
    }
  })
})
