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
 * Open the palette the way a user does. Cmd+K is owned by the native menu now - macOS resolves
 * accelerators before web contents see the key, which is the only way a shortcut survives a
 * focused terminal - and Playwright's synthetic key events do not reach the menu. Activating the
 * item exercises every step after the keystroke.
 */
async function openPalette(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById('palette.open')?.click()
  })
}

test('Cmd+K opens the palette; typing filters and Enter runs the command', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const wsDir = mkdtempSync(join(tmpdir(), 'palettews-'))
  const { app, win } = await launch(userDataDir)
  await addWorkspace(win, app, wsDir)

  // Open the palette and confirm it shows every registered command (workspaces/tabs/terminal +
  // the app-wide shortcut commands + the PR Review Inbox slice's prInbox.sync / prInbox.review +
  // the Sessions slice's sessions.refresh + the My Work slice's myWork.refresh + the Time
  // Tracking slice's timeTracking.refresh). The nine positional tab jumps and the palette's own
  // open command are mapped but deliberately not listed here.
  await openPalette(app)
  await expect(win.locator('.ix-palette')).toBeVisible()
  await expect(win.locator('.ix-palette__item')).toHaveCount(20)

  // The two deliberate exclusions, asserted by name so the count above cannot mask a regression:
  // the nine positional tab jumps, and the palette's own open command.
  await expect(win.locator('.ix-palette__title', { hasText: 'Tab 4' })).toHaveCount(0)
  await expect(win.locator('.ix-palette__title', { hasText: 'Command Palette' })).toHaveCount(0)

  // Filtering narrows the list to the Shell command as the top result.
  await win.locator('.ix-palette__input').fill('new shell')
  await expect(win.locator('.ix-palette__item--active .ix-palette__title')).toHaveText('New Shell Tab')

  // Enter runs it: a shell tab opens and the palette closes.
  await win.keyboard.press('Enter')
  await expect(win.locator('.ix-palette')).toHaveCount(0)
  await expect(win.locator('.ix-tab')).toHaveCount(1)
  await expect(win.locator('.ix-tab__title')).toHaveText('Shell')

  await app.close()
})

test('Escape closes the palette without running a command', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const wsDir = mkdtempSync(join(tmpdir(), 'palettews-'))
  const { app, win } = await launch(userDataDir)
  await addWorkspace(win, app, wsDir)

  await openPalette(app)
  await expect(win.locator('.ix-palette')).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(win.locator('.ix-palette')).toHaveCount(0)
  await expect(win.locator('.ix-tab')).toHaveCount(0)

  await app.close()
})
