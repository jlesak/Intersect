import { describe, expect, test, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { SHORTCUT_ACTIONS } from '@common/shortcuts'
import { appMenuTemplate } from './menu'

/** Every item in the template, submenus included, in declaration order. */
function walk(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? walk(item.submenu) : [])
  ])
}

function topLevel(
  template: MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions[] {
  const entry = template.find((item) => item.label === label)
  expect(entry, `top-level "${label}" menu`).toBeDefined()
  expect(Array.isArray(entry!.submenu)).toBe(true)
  return entry!.submenu as MenuItemConstructorOptions[]
}

/** Run an item's click handler the way Electron does, with arguments the template ignores. */
function fireClick(item: MenuItemConstructorOptions): void {
  const click = item.click as unknown as (() => void) | undefined
  expect(typeof click).toBe('function')
  click!()
}

describe('appMenuTemplate', () => {
  test('exposes every shortcut action with its id and accelerator', () => {
    const items = walk(appMenuTemplate(() => {}))
    for (const action of SHORTCUT_ACTIONS) {
      const item = items.find((i) => i.id === action.id)
      expect(item, `menu item for ${action.id}`).toBeDefined()
      expect(item!.label).toBe(action.label)
      expect(item!.accelerator).toBe(action.accelerator)
    }
  })

  test('clicking an item dispatches its own action id', () => {
    const invoke = vi.fn<(id: string) => void>()
    const items = walk(appMenuTemplate(invoke))
    for (const action of SHORTCUT_ACTIONS) {
      invoke.mockClear()
      fireClick(items.find((i) => i.id === action.id)!)
      expect(invoke.mock.calls).toEqual([[action.id]])
    }
  })

  test('starts with the application menu', () => {
    expect(appMenuTemplate(() => {})[0]).toEqual({ role: 'appMenu' })
  })

  test('File groups tab creation above Close Tab', () => {
    const file = topLevel(appMenuTemplate(() => {}), 'File')
    expect(file.map((item) => item.id ?? item.type)).toEqual([
      'tabs.new',
      'tabs.newWithPreset',
      'separator',
      'tabs.close'
    ])
  })

  test('Edit carries the six native clipboard and history roles', () => {
    const roles = topLevel(appMenuTemplate(() => {}), 'Edit').map((item) => item.role)
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) {
      expect(roles).toContain(role)
    }
  })

  test('View leads with the command palette and ends with the restored window roles', () => {
    const view = topLevel(appMenuTemplate(() => {}), 'View')
    expect(view.map((item) => item.id ?? item.role ?? item.type)).toEqual([
      'palette.open',
      'separator',
      'shell.toggleSidebar',
      'projects.next',
      'attention.jumpOldestWaiting',
      'separator',
      'togglefullscreen'
    ])
  })

  test('the nine tab jumps live in a submenu, not at the top of Window', () => {
    const window = topLevel(appMenuTemplate(() => {}), 'Window')
    expect(window.filter((item) => item.id?.startsWith('tabs.jump.'))).toEqual([])

    const goToTab = window.find((item) => item.label === 'Go to Tab')
    expect(goToTab).toBeDefined()
    const jumps = goToTab!.submenu as MenuItemConstructorOptions[]
    expect(jumps.map((item) => item.id)).toEqual([
      'tabs.jump.1',
      'tabs.jump.2',
      'tabs.jump.3',
      'tabs.jump.4',
      'tabs.jump.5',
      'tabs.jump.6',
      'tabs.jump.7',
      'tabs.jump.8',
      'tabs.jump.9'
    ])
  })

  test('Window keeps the native window roles', () => {
    const roles = topLevel(appMenuTemplate(() => {}), 'Window').map((item) => item.role)
    for (const role of ['minimize', 'zoom', 'front']) {
      expect(roles).toContain(role)
    }
  })

  // Electron's close role claims Cmd+W, which would shadow Close Tab.
  test('no item anywhere claims the close role', () => {
    const items = walk(appMenuTemplate(() => {}))
    expect(items.filter((item) => item.role === 'close')).toEqual([])
  })

  // Installing any menu displaces Electron's default one, which is where full screen used to
  // come from. Losing it would be a silent regression for every build.
  test('View restores full screen, and the inspector only outside a packaged build', () => {
    const shipped = topLevel(appMenuTemplate(() => {}), 'View').map((item) => item.role)
    expect(shipped).toContain('togglefullscreen')
    expect(shipped).not.toContain('toggleDevTools')
    expect(shipped).not.toContain('reload')

    const dev = topLevel(appMenuTemplate(() => {}, { devTools: true }), 'View').map(
      (item) => item.role
    )
    expect(dev).toContain('toggleDevTools')
    expect(dev).toContain('reload')
  })

  // A role's accelerator is filled in by Electron at build time and so is invisible here; what
  // this can still prove is that the map never declares one twice.
  test('no accelerator is declared twice across the whole menu', () => {
    const declared = walk(appMenuTemplate(() => {}, { devTools: true }))
      .map((item) => item.accelerator)
      .filter((accelerator): accelerator is string => Boolean(accelerator))
    expect(declared).toEqual([...new Set(declared)])
  })
})
