import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

const APP_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js')

test('app launches and renders the shell', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const app = await electron.launch({
    args: [APP_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, INTERSECT_E2E: '1' }
  })
  const win = await app.firstWindow()
  const errors: string[] = []
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  win.on('pageerror', (e) => errors.push(e.message))

  await expect(win.locator('.ix-wordmark__name')).toHaveText('Intersect')

  // Boot lands on My Work (the first section); the stubbed E2E board renders its empty state.
  await expect(win.locator('.ix-mw-empty-inline')).toBeVisible()

  // Switching to Workspaces renders its empty state.
  await win.locator('.ix-rail__btn', { hasText: 'Workspaces' }).click()
  await expect(win.locator('.ix-empty__title')).toBeVisible()

  await app.close()
  expect(errors, `renderer console errors:\n${errors.join('\n')}`).toEqual([])
})
