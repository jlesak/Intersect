import { type ElectronApplication } from '@playwright/test'
import { addWorkspace, expect, invokeMenu, launch, tempDir, test, userDataDir } from './harness'

/** Every command id the menu exposes, gathered depth-first so submenu items are included. */
async function menuItemIds(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ Menu }) => {
    const ids: string[] = []
    const walk = (items: Electron.MenuItem[]): void => {
      for (const item of items) {
        if (item.id) ids.push(item.id)
        if (item.submenu) walk(item.submenu.items)
      }
    }
    const menu = Menu.getApplicationMenu()
    if (menu) walk(menu.items)
    return ids
  })
}

test('the application menu exposes every mapped shortcut with its accelerator', async () => {
  const { app } = await launch(userDataDir(), { openOther: true })

  const ids = await menuItemIds(app)
  for (const id of [
    'tabs.new',
    'tabs.newWithPreset',
    'tabs.close',
    'tabs.next',
    'palette.open',
    'shell.toggleSidebar',
    'projects.next',
    'attention.jumpOldestWaiting',
    'terminal.fontIncrease',
    'terminal.fontDecrease',
    'terminal.fontReset'
  ]) {
    expect(ids, `menu is missing ${id}`).toContain(id)
  }
  // All nine positional jumps live in the Go to Tab submenu, so the walk must reach them.
  for (let n = 1; n <= 9; n += 1) expect(ids).toContain(`tabs.jump.${n}`)

  // Close Tab must keep Cmd+W: Electron's `close` role claims it and would shadow the item.
  const accelerators = await app.evaluate(({ Menu }) => {
    const found: Record<string, string | null> = {}
    const walk = (items: Electron.MenuItem[]): void => {
      for (const item of items) {
        if (item.id) found[item.id] = item.accelerator
        if (item.submenu) walk(item.submenu.items)
      }
    }
    const menu = Menu.getApplicationMenu()
    if (menu) walk(menu.items)
    return found
  })
  expect(accelerators['tabs.close']).toBe('CmdOrCtrl+W')
  expect(accelerators['palette.open']).toBe('CmdOrCtrl+K')
  expect(accelerators['tabs.next']).toBe('Control+Tab')
  expect(accelerators['terminal.fontIncrease']).toBe('CmdOrCtrl+=')
  expect(accelerators['terminal.fontDecrease']).toBe('CmdOrCtrl+-')
  expect(accelerators['terminal.fontReset']).toBe('CmdOrCtrl+0')
})

/**
 * A role's accelerator is supplied by Electron when the menu is built, so a clash between a
 * mapped shortcut and something like `minimize` (Cmd+M) or `selectAll` (Cmd+A) is invisible to
 * any pure-data test. Here the menu is real, so every accelerator is comparable - and a duplicate
 * means one of the two keys silently does the wrong thing.
 */
test('no two menu items anywhere claim the same accelerator', async () => {
  const { app } = await launch(userDataDir(), { openOther: true })

  const accelerators = await app.evaluate(({ Menu }) => {
    const found: string[] = []
    const walk = (items: Electron.MenuItem[]): void => {
      for (const item of items) {
        if (item.accelerator) found.push(item.accelerator)
        if (item.submenu) walk(item.submenu.items)
      }
    }
    const menu = Menu.getApplicationMenu()
    if (menu) walk(menu.items)
    return found
  })

  expect(accelerators.length).toBeGreaterThan(10)
  const duplicates = accelerators.filter((a, i) => accelerators.indexOf(a) !== i)
  expect(duplicates).toEqual([])
})

test('the Command Palette menu item opens and the palette shows its shortcut hint', async () => {
  const { app, win } = await launch(userDataDir(), { openOther: true })

  await invokeMenu(app, 'palette.open')
  await expect(win.locator('.ix-palette')).toBeVisible()

  // The hint proves the palette reads the same shortcut map the menu was built from.
  await win.locator('.ix-palette__input').fill('toggle sidebar')
  await expect(win.locator('.ix-palette__item--active .ix-kbd')).toHaveText('⌘B')

  // Terminal zoom is a keyboard habit, but it has to be discoverable without one.
  await win.locator('.ix-palette__input').fill('increase terminal font')
  await expect(win.locator('.ix-palette__item--active .ix-kbd')).toHaveText('⌘=')

  // The nine positional tab jumps are mapped but deliberately hidden from the palette.
  await win.locator('.ix-palette__input').fill('tab 4')
  await expect(win.locator('.ix-palette__item')).toHaveCount(0)

  await invokeMenu(app, 'palette.open')
  await expect(win.locator('.ix-palette')).toHaveCount(0)
})

test('Toggle Sidebar collapses the shell to its icon rail and back', async () => {
  const { app, win } = await launch(userDataDir(), { openOther: true })

  await expect(win.locator('.ix-app--rail')).toHaveCount(0)
  await invokeMenu(app, 'shell.toggleSidebar')
  await expect(win.locator('.ix-app--rail')).toHaveCount(1)
  await invokeMenu(app, 'shell.toggleSidebar')
  await expect(win.locator('.ix-app--rail')).toHaveCount(0)
})

test('New Tab opens the last-used preset, and Close Tab closes it', async () => {
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await addWorkspace(win, app, tempDir('shortcutws-'))

  // Nothing has been opened yet, so the remembered preset is still the Shell default.
  await invokeMenu(app, 'tabs.new')
  await expect(win.locator('.ix-tab')).toHaveCount(1)
  await expect(win.locator('.ix-tab__title')).toHaveText('Shell')

  await invokeMenu(app, 'tabs.new')
  await expect(win.locator('.ix-tab')).toHaveCount(2)

  await invokeMenu(app, 'tabs.close')
  await expect(win.locator('.ix-tab')).toHaveCount(1)
})

test('Close Tab is a no-op when no tab is open', async () => {
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await addWorkspace(win, app, tempDir('shortcutws-'))

  await expect(win.locator('.ix-tab')).toHaveCount(0)
  await invokeMenu(app, 'tabs.close')
  // Still nothing, and the window is still alive - the shell is what must not disappear here.
  await expect(win.locator('.ix-tab')).toHaveCount(0)
  await expect(win.locator('.ix-wordmark__name')).toBeVisible()
})

test('New Tab with Preset opens the preset picker', async () => {
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await addWorkspace(win, app, tempDir('shortcutws-'))

  await invokeMenu(app, 'tabs.newWithPreset')
  await expect(win.locator('.ix-presets')).toBeVisible()
  await win.locator('.ix-preset', { hasText: 'Shell' }).click()
  await expect(win.locator('.ix-tab')).toHaveCount(1)
})

test('Go to Tab jumps by position and Next Tab cycles', async () => {
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await addWorkspace(win, app, tempDir('shortcutws-'))

  for (let n = 0; n < 3; n += 1) await invokeMenu(app, 'tabs.new')
  await expect(win.locator('.ix-tab')).toHaveCount(3)

  await invokeMenu(app, 'tabs.jump.1')
  await expect(win.locator('.ix-tab').nth(0)).toHaveClass(/ix-tab--active/)

  // A position past the end lands on the last tab rather than doing nothing.
  await invokeMenu(app, 'tabs.jump.9')
  await expect(win.locator('.ix-tab').nth(2)).toHaveClass(/ix-tab--active/)

  // Next wraps from the last tab back to the first.
  await invokeMenu(app, 'tabs.next')
  await expect(win.locator('.ix-tab').nth(0)).toHaveClass(/ix-tab--active/)
})
