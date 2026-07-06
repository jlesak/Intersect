import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

const APP_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js')

/**
 * Deterministic wiring smoke test for the PR Review Inbox slice: the app boots with the slice
 * registered, the sidebar rail can switch to it and back to Workspaces, and its main view renders
 * (which imports Monaco - so a worker/CSP/import crash would surface here as a console error). Does
 * NOT touch Azure DevOps; live sync is a separate manual verification.
 */
test('PR Review Inbox section registers, switches, and renders without errors', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'jarvis-e2e-'))
  const app = await electron.launch({
    args: [APP_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, JARVIS_E2E: '1' }
  })
  const win = await app.firstWindow()
  const errors: string[] = []
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  win.on('pageerror', (e) => errors.push(e.message))

  await expect(win.locator('.jv-wordmark__name')).toHaveText('Jarvis')

  // The rail has both sections; switch to PR Review.
  const prRail = win.locator('.jv-rail__btn', { hasText: 'PR Review' })
  await expect(prRail).toBeVisible()
  await prRail.click()

  // The PR Inbox sidebar (Sync + empty state) and its main view render.
  await expect(win.locator('.jv-btn', { hasText: 'Sync' })).toBeVisible()
  await expect(win.locator('.jv-sidebar__list')).toContainText('Sync to load your pull requests')

  // Switch back to Workspaces - the section swap must not crash.
  await win.locator('.jv-rail__btn', { hasText: 'Workspaces' }).click()
  await expect(win.locator('.jv-empty__title')).toBeVisible()

  await app.close()
  expect(errors, `renderer console errors:\n${errors.join('\n')}`).toEqual([])
})
