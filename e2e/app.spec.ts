import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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

/** Stub the native folder picker so "Add workspace" resolves to a real temp dir. */
async function stubFolderPick(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, folder) => {
    ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder]
    })
  }, dir)
}

async function addWorkspace(win: Page, app: ElectronApplication, dir: string): Promise<void> {
  await stubFolderPick(app, dir)
  await win.locator('.ix-add').click()
  await win.locator('.ix-ws__rename').waitFor()
  await win.keyboard.press('Enter')
  await expect(win.locator('.ix-ws--active')).toBeVisible()
}

test('creates a workspace via the folder picker with the basename as its name', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const wsDir = mkdtempSync(join(tmpdir(), 'myproject-'))
  const { app, win } = await launch(userDataDir)
  await addWorkspace(win, app, wsDir)
  await expect(win.locator('.ix-ws--active .ix-ws__name')).toHaveText(basename(wsDir))
  await app.close()
})

test('opens a Shell terminal and streams command output', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const wsDir = mkdtempSync(join(tmpdir(), 'shellws-'))
  const { app, win } = await launch(userDataDir)
  await addWorkspace(win, app, wsDir)

  // Open Shell preset.
  await win.locator('.ix-iconbtn[title="New terminal"]').click()
  await win.locator('.ix-preset', { hasText: 'Shell' }).click()
  await expect(win.locator('.ix-tab')).toHaveCount(1)

  // Terminal renders; type a command and see its output.
  const term = win.locator('.xterm')
  await term.waitFor()
  await term.click()
  await win.keyboard.type('echo INTERSECT_E2E_OK\n')
  await expect(win.locator('.xterm-rows')).toContainText('INTERSECT_E2E_OK', { timeout: 20_000 })

  await app.close()
})

test('opens a Claude Code tab rooted in the workspace', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const wsDir = mkdtempSync(join(tmpdir(), 'claudews-'))
  const { app, win } = await launch(userDataDir)
  await addWorkspace(win, app, wsDir)

  await win.locator('.ix-iconbtn[title="New terminal"]').click()
  await win.locator('.ix-preset', { hasText: 'Claude Code' }).click()
  // The tab + its terminal exist regardless of whether `claude` is installed on this machine.
  await expect(win.locator('.ix-tab')).toHaveCount(1)
  await expect(win.locator('.ix-tab__preset')).toHaveText('AI')
  await expect(win.locator('.xterm')).toBeVisible()

  await app.close()
})

test('splits into two columns and places both terminals', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const wsDir = mkdtempSync(join(tmpdir(), 'splitws-'))
  const { app, win } = await launch(userDataDir)
  await addWorkspace(win, app, wsDir)

  const open = async (): Promise<void> => {
    await win.locator('.ix-iconbtn[title="New terminal"]').click()
    await win.locator('.ix-preset', { hasText: 'Shell' }).click()
  }
  await open()
  await open()
  await expect(win.locator('.ix-tab')).toHaveCount(2)

  await win.locator('.ix-layout[title="Two columns"]').click()
  await expect(win.locator('.ix-stage--columns')).toBeVisible()
  await expect(win.locator('.ix-pane')).toHaveCount(2)

  // Fill the empty pane with the other tab, then both panes host a terminal.
  await win.locator('.ix-pane--empty .ix-btn').first().click()
  await expect(win.locator('.ix-pane .xterm')).toHaveCount(2)

  await app.close()
})

test('deletes a workspace after confirming, leaving the folder on disk untouched', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const wsDir = mkdtempSync(join(tmpdir(), 'delws-'))
  const { app, win } = await launch(userDataDir)
  await addWorkspace(win, app, wsDir)
  await expect(win.locator('.ix-ws')).toHaveCount(1)

  await win.locator('.ix-ws').first().click({ button: 'right' })
  await win.locator('.ix-menu__item--danger', { hasText: 'Delete workspace' }).click()
  await win.locator('.ix-dialog').waitFor()
  await win.locator('.ix-dialog .ix-btn--danger').click()

  await expect(win.locator('.ix-ws')).toHaveCount(0)
  expect(existsSync(wsDir), 'workspace folder must not be deleted from disk').toBe(true)
  await app.close()
})

test('restores the selected workspace, its tabs and layout after restart', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const wsDir = mkdtempSync(join(tmpdir(), 'persistws-'))

  const first = await launch(userDataDir)
  await addWorkspace(first.win, first.app, wsDir)
  await first.win.locator('.ix-iconbtn[title="New terminal"]').click()
  await first.win.locator('.ix-preset', { hasText: 'Shell' }).click()
  await expect(first.win.locator('.ix-tab')).toHaveCount(1)
  await first.win.locator('.ix-layout[title="Two columns"]').click()
  await expect(first.win.locator('.ix-stage--columns')).toBeVisible()
  await first.app.close()

  // Relaunch against the same user-data dir.
  const second = await launch(userDataDir)
  await expect(second.win.locator('.ix-ws--active .ix-ws__name')).toHaveText(basename(wsDir))
  await expect(second.win.locator('.ix-tab')).toHaveCount(1)
  await expect(second.win.locator('.ix-stage--columns')).toBeVisible()
  await second.app.close()
})
