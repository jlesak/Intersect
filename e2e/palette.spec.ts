import { type ElectronApplication } from '@playwright/test'
import { addWorkspace, expect, invokeMenu, launch, tempDir, test, userDataDir } from './harness'

/**
 * Open the palette the way a user does. Cmd+K is owned by the native menu now - macOS resolves
 * accelerators before web contents see the key, which is the only way a shortcut survives a
 * focused terminal - and Playwright's synthetic key events do not reach the menu. Activating the
 * item exercises every step after the keystroke.
 */
async function openPalette(app: ElectronApplication): Promise<void> {
  await invokeMenu(app, 'palette.open')
}

test('Cmd+K opens the palette; typing filters and Enter runs the command', async () => {
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await addWorkspace(win, app, tempDir('palettews-'))

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

test('at rest the list is filed under headings; a command with nothing to act on will not run', async () => {
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await addWorkspace(win, app, tempDir('palettews-'))

  await openPalette(app)
  await expect(win.locator('.ix-palette__heading')).toHaveText([
    'Navigate',
    'Refresh',
    'Tabs & Layout',
    'Other'
  ])

  // The workspace is empty, so there is no tab for "Close Tab" to close. It stays listed - a
  // command that vanishes reads as a broken palette - but it is not offered as runnable.
  const closeTab = win.locator('.ix-palette__item', { hasText: 'Close Tab' })
  await expect(closeTab).toBeDisabled()

  // Give it something to act on. The same row, found the same way, now really does close the tab -
  // which is what stops the assertion above from passing against a row that is simply always dead.
  await win.locator('.ix-palette__input').fill('new shell')
  await win.keyboard.press('Enter')
  await expect(win.locator('.ix-tab')).toHaveCount(1)

  await openPalette(app)
  const closeAgain = win.locator('.ix-palette__item', { hasText: 'Close Tab' })
  await expect(closeAgain).toBeEnabled()
  await closeAgain.click()
  await expect(win.locator('.ix-palette')).toHaveCount(0)
  await expect(win.locator('.ix-tab')).toHaveCount(0)

  await app.close()
})

test('a command is found by a keyword its title never contains', async () => {
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await addWorkspace(win, app, tempDir('palettews-'))

  await openPalette(app)
  // "bash" appears nowhere in "New Shell Tab" - only in the command's own keywords.
  await win.locator('.ix-palette__input').fill('bash')
  await expect(win.locator('.ix-palette__item')).toHaveCount(1)
  await win.keyboard.press('Enter')
  await expect(win.locator('.ix-tab__title')).toHaveText('Shell')

  await app.close()
})

test('a command you ran leads the list next time, and still does after a relaunch', async () => {
  const profile = userDataDir()
  const workspace = tempDir('palettews-')
  const { app, win } = await launch(profile, { openOther: true })
  await addWorkspace(win, app, workspace)

  // Nothing has been run yet, so there is nothing to lead with.
  await openPalette(app)
  await expect(win.locator('.ix-palette__heading').first()).toHaveText('Navigate')
  await win.keyboard.press('Escape')

  // Run two commands. The second is the more recent, so it must end up above the first.
  await openPalette(app)
  await win.locator('.ix-palette__input').fill('layout rows')
  await win.keyboard.press('Enter')
  await openPalette(app)
  await win.locator('.ix-palette__input').fill('toggle sidebar')
  await win.keyboard.press('Enter')

  await openPalette(app)
  await expect(win.locator('.ix-palette__heading').first()).toHaveText('Recent')
  await expect(
    win.locator('.ix-palette__section').first().locator('.ix-palette__title')
  ).toHaveText(['Toggle Sidebar', 'Layout: Rows'])
  await app.close()

  // The list is the core's, not the window's: the same profile reopens onto the same history.
  const relaunched = await launch(profile, { openOther: true })
  await openPalette(relaunched.app)
  await expect(
    relaunched.win.locator('.ix-palette__section').first().locator('.ix-palette__title')
  ).toHaveText(['Toggle Sidebar', 'Layout: Rows'])

  await relaunched.app.close()
})

test('Escape closes the palette without running a command', async () => {
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await addWorkspace(win, app, tempDir('palettews-'))

  await openPalette(app)
  await expect(win.locator('.ix-palette')).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(win.locator('.ix-palette')).toHaveCount(0)
  await expect(win.locator('.ix-tab')).toHaveCount(0)

  await app.close()
})
