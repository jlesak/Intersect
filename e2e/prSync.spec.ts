import { expect, launch, openRailSection, tempDir, test, userDataDir } from './harness'

/**
 * Environment for a machine that has no Azure DevOps connection at all.
 *
 * Being connected is a property of the machine, not of the profile: a blank profile still inherits
 * an organisation URL and a token from `~/.claude.json` or from `AZURE_DEVOPS_*`, so on a developer
 * laptop a fresh profile is usually connected. Pointing the home directory at an empty temp dir and
 * blanking the environment pair is what makes "not connected" reproducible everywhere.
 */
function unconfigured(): Record<string, string> {
  return { HOME: tempDir('intersect-empty-home-'), AZURE_DEVOPS_ORG_URL: '', AZURE_DEVOPS_PAT: '' }
}

/**
 * Environment for a connected machine, resolved from the same empty home so only these credentials
 * can count. The values are never dialled: an E2E run answers every Azure DevOps call from the
 * canned backend, and what is under test is which of them the app decides to make.
 */
function connected(): Record<string, string> {
  return {
    HOME: tempDir('intersect-empty-home-'),
    AZURE_DEVOPS_ORG_URL: 'https://devops.example/e2e',
    AZURE_DEVOPS_PAT: 'e2e-token'
  }
}

/**
 * The case every launch on an unconfigured machine hits. Automatic refreshing must stay off there,
 * because a board that was never going to have data would otherwise wear a permanent failure notice
 * and re-attempt the whole per-repository fan-out on every return to the window.
 *
 * Any refresh that is attempted lands: the E2E backend always answers, and a sync that finds no
 * pull requests still stamps the board's freshness. So a chip still reading "never synced" after the
 * window has been focused is the evidence that nothing was attempted, and the manual Sync at the end
 * proves the chip would have said so.
 */
test('an unconnected board says it never synced and never refreshes itself', async () => {
  const { app, win } = await launch(userDataDir(), { env: unconfigured() })
  await openRailSection(win, 'PR Review', '.ix-board-head')

  const age = win.getByTestId('pr-sync-age')
  await expect(age).toHaveText('never synced')
  // Nothing was attempted, so there is nothing to confess: the failure line stays away rather than
  // reporting a refresh the app declined to make.
  await expect(win.getByTestId('pr-sync-error')).toHaveCount(0)
  await expect(win.locator('.ix-empty__hint')).toContainText('Sync to load your pull requests')

  await win.evaluate(() => window.dispatchEvent(new Event('focus')))
  // Leaving the section and coming back is a real round trip through the core, so a refresh that had
  // started on that focus would have landed by the time the board is on screen again.
  await win.locator('.ix-rail__btn--other').click()
  await openRailSection(win, 'PR Review', '.ix-board-head')
  await expect(age).toHaveText('never synced')

  // The loud path is untouched by the guard: asking for data by hand still works, and the freshness
  // it reports is what an automatic refresh would have shown had one run.
  await win.getByTestId('pr-sync').click()
  await expect(age).toHaveText('Synced just now')
  await expect(win.getByTestId('pr-sync-error')).toHaveCount(0)
  await expect(win.locator('.ix-crash')).toHaveCount(0)

  await app.close()
})

/**
 * The other half of the same guard: where there is a connection, the board is current before the
 * user asks. Without this the test above would pass just as happily on an app that never refreshes
 * itself at all.
 */
test('a connected board refreshes itself at boot with nobody pressing Sync', async () => {
  const { app, win } = await launch(userDataDir(), {
    env: { ...connected(), INTERSECT_E2E_ADO: 'radar' }
  })

  // The rail badge counts what needs my action, so it filling in on its own - before the section has
  // even been opened - is the boot refresh landing.
  await expect(win.getByTestId('pr-badge')).toHaveText('2')

  await openRailSection(win, 'PR Review', '.ix-board-head')
  await expect(win.getByTestId('pr-sync-age')).toHaveText('Synced just now')
  await expect(win.getByTestId('pr-sync-error')).toHaveCount(0)
  await expect(win.getByTestId('pr-col-action').getByTestId('pr-card')).toHaveCount(2)
  await expect(win.locator('.ix-crash')).toHaveCount(0)

  await app.close()
})
