import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const APP_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js')

async function launch(userDataDir: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: [APP_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, INTERSECT_E2E: '1' }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.ix-wordmark__name')
  // A fresh profile has no projects, so terminals live under the virtual Other context.
  await win.locator('.ix-rail__btn--other').click()
  return { app, win }
}

async function addWorkspace(win: Page, app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, folder) => {
    ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder]
    })
  }, dir)
  await win.locator('.ix-add').click()
  await win.locator('.ix-ws__rename').waitFor()
  await win.keyboard.press('Enter')
  await expect(win.locator('.ix-ws--active')).toBeVisible()
}

/**
 * Fire a real application-menu item by its command id. Playwright cannot deliver an OS-level
 * accelerator, so activating the item itself is the closest reachable equivalent: everything
 * downstream of the keystroke - the menu wiring, the IPC hop and the renderer's dispatch - runs
 * exactly as it does for a user pressing the key.
 */
async function invokeMenuItem(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
    if (!item) throw new Error(`no application menu item with id "${itemId}"`)
    item.click()
  }, id)
}

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
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const { app } = await launch(userDataDir)

  const ids = await menuItemIds(app)
  for (const id of [
    'tabs.new',
    'tabs.newWithPreset',
    'tabs.close',
    'tabs.next',
    'palette.open',
    'shell.toggleSidebar',
    'projects.next',
    'attention.jumpOldestWaiting'
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

  await app.close()
})

/**
 * A role's accelerator is supplied by Electron when the menu is built, so a clash between a
 * mapped shortcut and something like `minimize` (Cmd+M) or `selectAll` (Cmd+A) is invisible to
 * any pure-data test. Here the menu is real, so every accelerator is comparable - and a duplicate
 * means one of the two keys silently does the wrong thing.
 */
test('no two menu items anywhere claim the same accelerator', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const { app } = await launch(userDataDir)

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

  await app.close()
})

test('the Command Palette menu item opens and the palette shows its shortcut hint', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const { app, win } = await launch(userDataDir)

  await invokeMenuItem(app, 'palette.open')
  await expect(win.locator('.ix-palette')).toBeVisible()

  // The hint proves the palette reads the same shortcut map the menu was built from.
  await win.locator('.ix-palette__input').fill('toggle sidebar')
  await expect(win.locator('.ix-palette__item--active .ix-kbd')).toHaveText('⌘B')

  // The nine positional tab jumps are mapped but deliberately hidden from the palette.
  await win.locator('.ix-palette__input').fill('tab 4')
  await expect(win.locator('.ix-palette__item')).toHaveCount(0)

  await invokeMenuItem(app, 'palette.open')
  await expect(win.locator('.ix-palette')).toHaveCount(0)

  await app.close()
})

test('Toggle Sidebar collapses the shell to its icon rail and back', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const { app, win } = await launch(userDataDir)

  await expect(win.locator('.ix-app--rail')).toHaveCount(0)
  await invokeMenuItem(app, 'shell.toggleSidebar')
  await expect(win.locator('.ix-app--rail')).toHaveCount(1)
  await invokeMenuItem(app, 'shell.toggleSidebar')
  await expect(win.locator('.ix-app--rail')).toHaveCount(0)

  await app.close()
})

test('New Tab opens the last-used preset, and Close Tab closes it', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const wsDir = mkdtempSync(join(tmpdir(), 'shortcutws-'))
  const { app, win } = await launch(userDataDir)
  await addWorkspace(win, app, wsDir)

  // Nothing has been opened yet, so the remembered preset is still the Shell default.
  await invokeMenuItem(app, 'tabs.new')
  await expect(win.locator('.ix-tab')).toHaveCount(1)
  await expect(win.locator('.ix-tab__title')).toHaveText('Shell')

  await invokeMenuItem(app, 'tabs.new')
  await expect(win.locator('.ix-tab')).toHaveCount(2)

  await invokeMenuItem(app, 'tabs.close')
  await expect(win.locator('.ix-tab')).toHaveCount(1)

  await app.close()
})

test('Close Tab is a no-op when no tab is open', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const wsDir = mkdtempSync(join(tmpdir(), 'shortcutws-'))
  const { app, win } = await launch(userDataDir)
  await addWorkspace(win, app, wsDir)

  await expect(win.locator('.ix-tab')).toHaveCount(0)
  await invokeMenuItem(app, 'tabs.close')
  // Still nothing, and the window is still alive - the shell is what must not disappear here.
  await expect(win.locator('.ix-tab')).toHaveCount(0)
  await expect(win.locator('.ix-wordmark__name')).toBeVisible()

  await app.close()
})

test('New Tab with Preset opens the preset picker', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const wsDir = mkdtempSync(join(tmpdir(), 'shortcutws-'))
  const { app, win } = await launch(userDataDir)
  await addWorkspace(win, app, wsDir)

  await invokeMenuItem(app, 'tabs.newWithPreset')
  await expect(win.locator('.ix-presets')).toBeVisible()
  await win.locator('.ix-preset', { hasText: 'Shell' }).click()
  await expect(win.locator('.ix-tab')).toHaveCount(1)

  await app.close()
})

test('Go to Tab jumps by position and Next Tab cycles', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const wsDir = mkdtempSync(join(tmpdir(), 'shortcutws-'))
  const { app, win } = await launch(userDataDir)
  await addWorkspace(win, app, wsDir)

  for (let n = 0; n < 3; n += 1) await invokeMenuItem(app, 'tabs.new')
  await expect(win.locator('.ix-tab')).toHaveCount(3)

  await invokeMenuItem(app, 'tabs.jump.1')
  await expect(win.locator('.ix-tab').nth(0)).toHaveClass(/ix-tab--active/)

  // A position past the end lands on the last tab rather than doing nothing.
  await invokeMenuItem(app, 'tabs.jump.9')
  await expect(win.locator('.ix-tab').nth(2)).toHaveClass(/ix-tab--active/)

  // Next wraps from the last tab back to the first.
  await invokeMenuItem(app, 'tabs.next')
  await expect(win.locator('.ix-tab').nth(0)).toHaveClass(/ix-tab--active/)

  await app.close()
})
