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
  // Boot lands on My Work (the first section); these tests exercise the Workspaces section.
  await win.locator('.ix-rail__btn', { hasText: 'Workspaces' }).click()
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

async function openShellTab(win: Page): Promise<void> {
  await win.locator('.ix-iconbtn[title="New terminal"]').click()
  await win.locator('.ix-preset', { hasText: 'Shell' }).click()
}

/**
 * A background terminal that prints Intersect's OSC 9 idle marker must turn its tab 'done' (green)
 * and pulse. The marker is emitted from a session that is NOT the active one, so the alert is not
 * suppressed as "already viewed". Clicking the tab acknowledges it and clears the status.
 */
test('a background session that signals idle turns its tab done, and viewing it clears the status', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const wsDir = mkdtempSync(join(tmpdir(), 'attn-'))
  const { app, win } = await launch(userDataDir)
  await addWorkspace(win, app, wsDir)

  // Tab A: schedule the idle marker to print shortly, in the background, then hand focus away.
  await openShellTab(win)
  await expect(win.locator('.ix-tab')).toHaveCount(1)
  const term = win.locator('.xterm')
  await term.waitFor()
  await term.click()
  // printf turns \033/\007 into the real ESC/BEL; backgrounded so we can switch tabs immediately.
  await win.keyboard.type("(sleep 1 && printf '\\033]9;INTERSECT_IDLE\\007') &\n")

  // Tab B becomes the active session, so A is now a background session.
  await openShellTab(win)
  await expect(win.locator('.ix-tab')).toHaveCount(2)

  // The background tab A turns done once its scheduled marker lands.
  await expect(win.locator('.ix-tab--done')).toHaveCount(1, { timeout: 8000 })

  // Opening (activating) the tab acknowledges it and clears the status.
  await win.locator('.ix-tab--done').click()
  await expect(win.locator('.ix-tab--done')).toHaveCount(0)

  await app.close()
})

/**
 * Submitting a prompt into a Claude Code tab (Enter) must mark it 'working' (blue), independent of
 * whether the `claude` binary is actually installed on this machine - the detection is driven by
 * the user's keystroke into a claude-preset session, not by anything Claude itself outputs.
 */
test('submitting a prompt in a Claude tab marks it working', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const wsDir = mkdtempSync(join(tmpdir(), 'attn-working-'))
  const { app, win } = await launch(userDataDir)
  await addWorkspace(win, app, wsDir)

  await win.locator('.ix-iconbtn[title="New terminal"]').click()
  await win.locator('.ix-preset', { hasText: 'Claude Code' }).click()
  await expect(win.locator('.ix-tab')).toHaveCount(1)

  const term = win.locator('.xterm')
  await term.waitFor()
  await term.click()
  await win.keyboard.type('hello\n')

  await expect(win.locator('.ix-tab--working')).toHaveCount(1)

  await app.close()
})
