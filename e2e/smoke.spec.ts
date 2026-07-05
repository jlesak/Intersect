import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

const APP_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js')

test('app launches and renders the shell', async () => {
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
  await expect(win.locator('.jv-empty__title')).toBeVisible()

  await app.close()
  expect(errors, `renderer console errors:\n${errors.join('\n')}`).toEqual([])
})
