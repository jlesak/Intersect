import { expect, launch, tempDir, test } from './harness'

/**
 * LIVE verification against the real on-prem Azure DevOps (needs VPN + INTERSECT_ADO_IDENTITY). Syncs
 * the real PR list, selects a PR, and renders its diff. Stops before any AI review / publish.
 * Not part of the default suite's assumptions; run explicitly.
 */
test('live: sync real PRs and render a diff', async () => {
  test.skip(!process.env.INTERSECT_LIVE_E2E, 'live ADO test; run with INTERSECT_LIVE_E2E=1 on VPN')
  test.setTimeout(240_000)
  // Blanking INTERSECT_E2E is what leaves anything here worth verifying: the core answers every
  // Azure DevOps call from canned fixtures when it reads exactly '1', and this is the one test that
  // must reach the real server. Credentials come from the real home directory, which stays as it is.
  const { win } = await launch(tempDir('intersect-live-'), {
    env: {
      INTERSECT_E2E: '',
      INTERSECT_ADO_IDENTITY:
        process.env.INTERSECT_ADO_IDENTITY || '6dc11d09-387d-4a25-8699-0dc709e21280'
    }
  })
  await win.locator('.ix-rail__btn', { hasText: 'PR Review' }).click()

  // Sync against real ADO.
  await win.getByTestId('pr-sync').click()
  await expect(win.getByTestId('pr-card').first()).toBeVisible({ timeout: 180_000 })
  const count = await win.getByTestId('pr-card').count()
  console.log(`LIVE: synced ${count} pull request(s)`)

  // Open the first PR and load its changed-files tree.
  await win.getByTestId('pr-card').first().click()
  const files = win.getByTestId('tree-file')
  await expect(files.first()).toBeVisible({ timeout: 60_000 })
  const fileCount = await files.count()
  console.log(`LIVE: first PR has ${fileCount} changed file(s)`)

  // Open a file -> the Monaco diff renders.
  await files.first().click()
  await expect(win.locator('.monaco-diff-editor').first()).toBeVisible({ timeout: 30_000 })
  console.log('LIVE: Monaco diff rendered')

  await win.screenshot({ path: 'test-results/pr-inbox-live.png' })
})
