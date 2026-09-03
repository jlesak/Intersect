import { type Page } from '@playwright/test'
import {
  expect,
  launch,
  openRailSection,
  stubFolderPick,
  tempDir,
  test,
  userDataDir
} from './harness'

/** Open the Settings section via its footer rail button (pinned below the daily sections). */
async function openSettings(win: Page): Promise<void> {
  await openRailSection(win, 'Settings', '.ix-settings')
}

/** Click a settings toggle by its accessible name (the input itself is visually hidden). */
async function flipToggle(win: Page, label: string): Promise<void> {
  await win
    .locator('.ix-toggle', { has: win.getByLabel(label, { exact: true }) })
    .locator('.ix-toggle__track')
    .click()
}

test('Settings opens from the footer rail with every category and the notification defaults', async () => {
  const { win } = await launch(userDataDir())

  // Asserted here rather than in the shared opener: every other section reaches the rail through
  // the same helper, and only Settings is pinned below the daily ones. Without this the section
  // could drift up into the rail proper and every Settings test would still pass.
  await expect(win.locator('.ix-rail__foot .ix-rail__btn', { hasText: 'Settings' })).toBeVisible()

  await openSettings(win)

  await expect(win.locator('.ix-settings__nav-btn')).toHaveText([
    'Projekty',
    'Agent Tooling',
    'Notifikace',
    'Azure DevOps',
    'PR Review',
    'Sessions',
    'Klávesové zkratky',
    'Vzhled'
  ])

  // Projects is the landing pane: the daily entry point is managing what the rail pins.
  await expect(win.locator('.ix-settings__pane--active .ix-settings__title')).toHaveText('Projekty')

  // Notifications keep the pre-settings behavior as defaults: everything alerts except the
  // informational 'working' status.
  await win.locator('.ix-settings__nav-btn', { hasText: 'Notifikace' }).click()
  await expect(win.locator('.ix-settings__pane--active .ix-settings__title')).toHaveText('Notifikace')
  await expect(win.getByLabel('Systémové notifikace', { exact: true })).toBeChecked()
  await expect(win.getByLabel('Working', { exact: true })).not.toBeChecked()
  await expect(win.getByLabel('Waiting', { exact: true })).toBeChecked()
  await expect(win.getByLabel('Done', { exact: true })).toBeChecked()
  await expect(win.getByLabel('Zvuk', { exact: true })).toBeChecked()
})

test('only the active category pane is in the DOM', async () => {
  const { win } = await launch(userDataDir())
  await openSettings(win)

  await expect(win.locator('.ix-settings__pane')).toHaveCount(1)

  await win.locator('.ix-settings__nav-btn', { hasText: 'Vzhled' }).click()
  await expect(win.locator('.ix-settings__pane')).toHaveCount(1)
  await expect(win.locator('#ix-set-review-prompt')).toHaveCount(0)
})

/**
 * The project fields commit on blur rather than on every keystroke, and leaving the category now
 * unmounts them. Clicking the sub-navigation has to blur the field first, so the edit is saved on
 * the way out - anything else silently discards what the user just typed.
 */
test('a project name typed but not blurred survives switching category', async () => {
  const projectDir = tempDir('settingsproj-')
  const { app, win } = await launch(userDataDir())
  await openSettings(win)

  await stubFolderPick(app, projectDir)
  await win.getByRole('button', { name: 'Nový projekt (vybrat složku)' }).click()

  const name = win.locator('input[id^="ix-proj-name-"]')
  await expect(name).toHaveCount(1)
  await name.fill('Přejmenovaný projekt')

  await win.locator('.ix-settings__nav-btn', { hasText: 'Vzhled' }).click()
  await win.locator('.ix-settings__nav-btn', { hasText: 'Projekty' }).click()
  await expect(name).toHaveValue('Přejmenovaný projekt')
})

test('switching categories never loses the typed ADO values, and the shortcuts table is read-only', async () => {
  const { win } = await launch(userDataDir())
  await openSettings(win)

  await win.locator('.ix-settings__nav-btn', { hasText: 'Azure DevOps' }).click()
  await win.locator('#ix-set-ado-orgUrl').fill('https://devops.example.com/tfs/Col')
  await win.locator('#ix-set-ado-project').fill('SPOT')

  // Away to the shortcuts overview and back: the typed values are still there.
  await win.locator('.ix-settings__nav-btn', { hasText: 'Klávesové zkratky' }).click()
  // The app-wide rows come from the same map the native menu is built from, so the overview cannot
  // drift from what is actually bound. Row order follows that map and is not asserted here.
  await expect(win.locator('.ix-kshort-table tr', { hasText: 'Command Palette' })).toHaveCount(1)
  await expect(win.locator('.ix-kshort-table tr', { hasText: 'Toggle Sidebar' })).toHaveCount(1)
  await expect(win.locator('.ix-kshort-table input')).toHaveCount(0)

  await win.locator('.ix-settings__nav-btn', { hasText: 'Azure DevOps' }).click()
  await expect(win.locator('#ix-set-ado-orgUrl')).toHaveValue('https://devops.example.com/tfs/Col')
  await expect(win.locator('#ix-set-ado-project')).toHaveValue('SPOT')
})

test('test connection reports the authenticated user inline', async () => {
  const { win } = await launch(userDataDir())
  await openSettings(win)

  await win.locator('.ix-settings__nav-btn', { hasText: 'Azure DevOps' }).click()
  await win.locator('#ix-set-ado-orgUrl').fill('https://devops.example.com/tfs/Col')
  await win.locator('#ix-set-ado-pat').fill('e2e-pat')
  await win.locator('.ix-settings__test .ix-btn').click()
  await expect(win.locator('.ix-settings__test-msg--ok')).toHaveText('✓ Připojeno jako E2E User')

  // Editing any field (to a genuinely different value) invalidates the stale outcome.
  await win.locator('#ix-set-ado-project').fill('SomeOtherProject')
  await expect(win.locator('.ix-settings__test-msg--ok')).toHaveCount(0)
})

test('notification, ADO, PR-review prompt, and font-size changes survive a relaunch', async () => {
  const profileDir = userDataDir()
  const reviewPrompt = '  Review this pull request in English.\n\nKeep this exact spacing.  \n'
  const first = await launch(profileDir)
  await openSettings(first.win)

  await first.win.locator('.ix-settings__nav-btn', { hasText: 'Notifikace' }).click()
  await flipToggle(first.win, 'Zvuk')
  await expect(first.win.getByLabel('Zvuk', { exact: true })).not.toBeChecked()

  await first.win.locator('.ix-settings__nav-btn', { hasText: 'Azure DevOps' }).click()
  await first.win.locator('#ix-set-ado-repository').fill('spot-repo')

  await first.win.locator('.ix-settings__nav-btn', { hasText: 'PR Review' }).click()
  await first.win.locator('#ix-set-review-prompt').fill(reviewPrompt)
  // A fresh profile reviews on Opus without any configuration.
  await expect(first.win.locator('#ix-set-review-model')).toHaveValue('opus')
  await first.win.locator('#ix-set-review-model').fill('claude-opus-5')

  await first.win.locator('.ix-settings__nav-btn', { hasText: 'Vzhled' }).click()
  const slider = first.win.locator('#ix-set-font-size')
  await slider.focus()
  await slider.press('End')
  await expect(first.win.locator('.ix-set-slider__value')).toHaveText('20px')

  await first.app.close()

  const second = await launch(profileDir)
  await openSettings(second.win)
  await second.win.locator('.ix-settings__nav-btn', { hasText: 'Notifikace' }).click()
  await expect(second.win.getByLabel('Zvuk', { exact: true })).not.toBeChecked()
  await second.win.locator('.ix-settings__nav-btn', { hasText: 'Azure DevOps' }).click()
  await expect(second.win.locator('#ix-set-ado-repository')).toHaveValue('spot-repo')
  await second.win.locator('.ix-settings__nav-btn', { hasText: 'PR Review' }).click()
  await expect(second.win.locator('#ix-set-review-prompt')).toHaveValue(reviewPrompt)
  await expect(second.win.locator('#ix-set-review-model')).toHaveValue('claude-opus-5')

  // Leave no custom prompt or model behind if this user-data directory is kept for troubleshooting.
  await second.win.getByRole('button', { name: 'Obnovit výchozí prompt a model' }).click()
  await expect(second.win.locator('#ix-set-review-prompt')).toHaveValue(/^Zrecenzuj pull request/)
  await expect(second.win.locator('#ix-set-review-model')).toHaveValue('opus')

  await second.win.locator('.ix-settings__nav-btn', { hasText: 'Vzhled' }).click()
  await expect(second.win.locator('.ix-set-slider__value')).toHaveText('20px')
})
