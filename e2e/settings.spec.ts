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
  return { app, win }
}

/** Open the Settings section via its footer rail button (pinned below the daily sections). */
async function openSettings(win: Page): Promise<void> {
  await win.locator('.ix-rail__foot .ix-rail__btn', { hasText: 'Settings' }).click()
  await win.locator('.ix-settings').waitFor()
}

/** Click a settings toggle by its accessible name (the input itself is visually hidden). */
async function flipToggle(win: Page, label: string): Promise<void> {
  await win
    .locator('.ix-toggle', { has: win.getByLabel(label, { exact: true }) })
    .locator('.ix-toggle__track')
    .click()
}

test('Settings opens from the footer rail with four categories and the notification defaults', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const { app, win } = await launch(userDataDir)
  await openSettings(win)

  await expect(win.locator('.ix-settings__nav-btn')).toHaveText([
    'Notifikace',
    'Azure DevOps',
    'Klávesové zkratky',
    'Vzhled'
  ])

  // Notifications is the default pane, with the pre-settings behavior as defaults:
  // everything alerts except the informational 'working' status.
  await expect(win.locator('.ix-settings__pane--active .ix-settings__title')).toHaveText('Notifikace')
  await expect(win.getByLabel('Systémové notifikace', { exact: true })).toBeChecked()
  await expect(win.getByLabel('Working', { exact: true })).not.toBeChecked()
  await expect(win.getByLabel('Waiting', { exact: true })).toBeChecked()
  await expect(win.getByLabel('Done', { exact: true })).toBeChecked()
  await expect(win.getByLabel('Zvuk', { exact: true })).toBeChecked()

  await app.close()
})

test('switching categories never loses the typed ADO values, and the shortcuts table is read-only', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const { app, win } = await launch(userDataDir)
  await openSettings(win)

  await win.locator('.ix-settings__nav-btn', { hasText: 'Azure DevOps' }).click()
  await win.locator('#ix-set-ado-orgUrl').fill('https://devops.example.com/tfs/Col')
  await win.locator('#ix-set-ado-project').fill('SPOT')

  // Away to the shortcuts overview and back: the typed values are still there.
  await win.locator('.ix-settings__nav-btn', { hasText: 'Klávesové zkratky' }).click()
  await expect(win.locator('.ix-kshort-table tr').first()).toContainText('Command Palette')
  await expect(win.locator('.ix-kshort-table input')).toHaveCount(0)

  await win.locator('.ix-settings__nav-btn', { hasText: 'Azure DevOps' }).click()
  await expect(win.locator('#ix-set-ado-orgUrl')).toHaveValue('https://devops.example.com/tfs/Col')
  await expect(win.locator('#ix-set-ado-project')).toHaveValue('SPOT')

  await app.close()
})

test('test connection reports the authenticated user inline', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const { app, win } = await launch(userDataDir)
  await openSettings(win)

  await win.locator('.ix-settings__nav-btn', { hasText: 'Azure DevOps' }).click()
  await win.locator('#ix-set-ado-orgUrl').fill('https://devops.example.com/tfs/Col')
  await win.locator('#ix-set-ado-pat').fill('e2e-pat')
  await win.locator('.ix-settings__test .ix-btn').click()
  await expect(win.locator('.ix-settings__test-msg--ok')).toHaveText('✓ Připojeno jako E2E User')

  // Editing any field (to a genuinely different value) invalidates the stale outcome.
  await win.locator('#ix-set-ado-project').fill('SomeOtherProject')
  await expect(win.locator('.ix-settings__test-msg--ok')).toHaveCount(0)

  await app.close()
})

test('notification, ADO, and font-size changes survive a relaunch', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const first = await launch(userDataDir)
  await openSettings(first.win)

  await flipToggle(first.win, 'Zvuk')
  await expect(first.win.getByLabel('Zvuk', { exact: true })).not.toBeChecked()

  await first.win.locator('.ix-settings__nav-btn', { hasText: 'Azure DevOps' }).click()
  await first.win.locator('#ix-set-ado-repository').fill('spot-repo')

  await first.win.locator('.ix-settings__nav-btn', { hasText: 'Vzhled' }).click()
  const slider = first.win.locator('#ix-set-font-size')
  await slider.focus()
  await slider.press('End')
  await expect(first.win.locator('.ix-set-slider__value')).toHaveText('20px')

  await first.app.close()

  const second = await launch(userDataDir)
  await openSettings(second.win)
  await expect(second.win.getByLabel('Zvuk', { exact: true })).not.toBeChecked()
  await second.win.locator('.ix-settings__nav-btn', { hasText: 'Azure DevOps' }).click()
  await expect(second.win.locator('#ix-set-ado-repository')).toHaveValue('spot-repo')
  await second.win.locator('.ix-settings__nav-btn', { hasText: 'Vzhled' }).click()
  await expect(second.win.locator('.ix-set-slider__value')).toHaveText('20px')
  await second.app.close()
})
