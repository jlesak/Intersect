import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

const APP_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js')

/**
 * LIVE verification against the real on-prem Azure DevOps (needs VPN + INTERSECT_ADO_IDENTITY). Syncs
 * the real PR list, selects a PR, and renders its diff. Stops before any AI review / publish.
 * Not part of the default suite's assumptions; run explicitly.
 */
test('live: sync real PRs and render a diff', async () => {
  test.skip(!process.env.INTERSECT_LIVE_E2E, 'live ADO test; run with INTERSECT_LIVE_E2E=1 on VPN')
  test.setTimeout(240_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-live-'))
  const app = await electron.launch({
    args: [APP_ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      INTERSECT_ADO_IDENTITY: process.env.INTERSECT_ADO_IDENTITY || '6dc11d09-387d-4a25-8699-0dc709e21280'
    }
  })
  const win = await app.firstWindow()
  await win.locator('.ix-wordmark__name').waitFor()
  await win.locator('.ix-rail__btn', { hasText: 'PR Review' }).click()

  // Sync against real ADO.
  await win.locator('.ix-btn', { hasText: 'Sync' }).click()
  await expect(win.locator('.ix-pr-row').first()).toBeVisible({ timeout: 180_000 })
  const count = await win.locator('.ix-pr-row').count()
  console.log(`LIVE: synced ${count} pull request(s)`)

  // Open the first PR and load its changed files.
  await win.locator('.ix-pr-row').first().click()
  const files = win.locator('.ix-pr-file')
  await expect(files.first()).toBeVisible({ timeout: 60_000 })
  const fileCount = await files.count()
  console.log(`LIVE: first PR has ${fileCount} changed file(s)`)

  // Open a file -> the Monaco diff renders.
  await files.first().click()
  await expect(win.locator('.monaco-diff-editor').first()).toBeVisible({ timeout: 30_000 })
  console.log('LIVE: Monaco diff rendered')

  await win.screenshot({ path: 'test-results/pr-inbox-live.png' })
  await app.close()
})
