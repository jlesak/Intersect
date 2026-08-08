import { type ElectronApplication, type Page } from '@playwright/test'
import {
  connectedAdo,
  expect,
  launch as launchApp,
  openRailSection,
  test,
  userDataDir
} from './harness'

/**
 * Launch the app with the stubbed My Work backends in the given modes (see jiraE2eStub / adoE2eStub).
 *
 * Always on a connected machine. The PR radar is filled by the app's own automatic refresh, which
 * runs only where Azure DevOps is reachable, so a machine without credentials would leave the radar
 * empty and every assertion about it meaningless. Saying so here is what keeps that independent of
 * whose laptop runs the suite.
 *
 * The profile directory is returned so a test can relaunch into the same one and assert what the
 * first run persisted. Defaulting it here rather than at the call site is safe because a default
 * parameter is evaluated on each call, inside the test, where the harness drains what it creates.
 */
async function launch(
  env: Record<string, string>,
  profileDir = userDataDir()
): Promise<{ app: ElectronApplication; win: Page; profileDir: string }> {
  const { app, win } = await launchApp(profileDir, { env: { ...connectedAdo(), ...env } })
  // Boot lands on Claude Code, not My Work; switch to the section these tests exercise.
  await openRailSection(win, 'My Work', '.ix-mywork')
  return { app, win, profileDir }
}

test('with no saved session, My Work offers the login without opening it, and a click loads the board', async () => {
  const { app, win } = await launch({ INTERSECT_E2E_JIRA: 'auth' })

  // The auth failure renders the error card with the login action - never an automatic login.
  await expect(win.locator('.ix-mw-error__title')).toHaveText('Could not load Jira issues')
  await expect(win.locator('.ix-mw-error__body')).toContainText('no active Jira SSO session')
  const loginButton = win.locator('.ix-mw-error button', { hasText: 'Log in to Jira' })
  await expect(loginButton).toBeVisible()

  // Only the explicit click starts the SSO login; the stub login succeeds and the follow-up
  // fetch renders the sample board.
  await loginButton.click()
  await expect(win.locator('.ix-mw-loading')).toContainText('Complete the SSO login')
  await expect(win.locator('.ix-mw-card2')).toHaveCount(3)
  await expect(win.locator('.ix-mw-col--todo .ix-mw-card2 .ix-mw-key')).toHaveText('FID2507-1')
  await expect(win.locator('.ix-mw-col--progress .ix-mw-card2 .ix-mw-key')).toHaveText('FID2507-2')
  await expect(win.locator('.ix-mw-col--review .ix-mw-card2 .ix-mw-key')).toHaveText('FID2507-3')
  await expect(win.locator('.ix-mw-section__count')).toHaveText('3')

  await app.close()
})

test('an abandoned login returns to the auth error card with the log-in action', async () => {
  const { app, win } = await launch({
    INTERSECT_E2E_JIRA: 'auth',
    INTERSECT_E2E_JIRA_LOGIN: 'fail'
  })

  await expect(win.locator('.ix-mw-error__title')).toHaveText('Could not load Jira issues')
  await win.locator('.ix-mw-error button', { hasText: 'Log in to Jira' }).click()
  await expect(win.locator('.ix-mw-error__title')).toHaveText('Could not load Jira issues')
  await expect(win.locator('.ix-mw-error__body')).toContainText('no active Jira SSO session')
  await expect(win.locator('.ix-mw-error button')).toHaveText(/Log in to Jira/)

  await app.close()
})

test('a generic fetch failure shows the error card with a retry action', async () => {
  const { app, win } = await launch({ INTERSECT_E2E_JIRA: 'error' })

  await expect(win.locator('.ix-mw-error__title')).toHaveText('Could not load Jira issues')
  await expect(win.locator('.ix-mw-error__body')).toContainText('Stubbed fetch failure')
  await expect(win.locator('.ix-mw-error button')).toHaveText(/Try again/)

  await app.close()
})

test('the persisted board renders instantly on the next boot, even when the fresh fetch fails', async () => {
  // First run fetches and persists the sample board.
  const first = await launch({ INTERSECT_E2E_JIRA: 'board' })
  await expect(first.win.locator('.ix-mw-card2')).toHaveCount(3)
  await first.app.close()

  // Second run in the same profile: the fetch now fails, but the persisted board still shows.
  const second = await launch({ INTERSECT_E2E_JIRA: 'error' }, first.profileDir)
  await expect(second.win.locator('.ix-mw-card2')).toHaveCount(3)
  await expect(second.win.locator('.ix-mywork__subtitle')).toContainText(/Last refreshed|Refreshing/)
  await expect(second.win.locator('.ix-mw-error')).toHaveCount(0)
  await second.app.close()
})

test('a loaded board renders all five columns and refresh keeps it current', async () => {
  const { app, win } = await launch({ INTERSECT_E2E_JIRA: 'board' })

  await expect(win.locator('.ix-mw-col')).toHaveCount(5)
  await expect(win.locator('.ix-mw-card2')).toHaveCount(3)
  await expect(win.locator('.ix-mywork__subtitle')).toContainText('Last refreshed')

  await win.locator('.ix-mywork__topbar button', { hasText: 'Refresh' }).click()
  await expect(win.locator('.ix-mw-card2')).toHaveCount(3)

  await app.close()
})

test('typing narrows the board to the one issue meant, and the emptied columns step aside', async () => {
  const { app, win } = await launch({ INTERSECT_E2E_JIRA: 'board' })
  await expect(win.locator('.ix-mw-card2')).toHaveCount(3)

  // "vbst" is nowhere in the board as a run of characters; only a real subsequence matcher finds
  // "Verify the Board STates", so a filter falling back to substring search would show nothing.
  await win.getByTestId('jira-filter').fill('vbst')

  await expect(win.locator('.ix-mw-card2 .ix-mw-key')).toHaveText(['FID2507-3'])
  await expect(win.getByTestId('jira-filter-count')).toHaveText('1 of 3')

  // Every column is still a column - the four with nothing left are strips that still say which
  // column they are, and the one holding the survivor is untouched.
  await expect(win.locator('.ix-mw-col')).toHaveCount(5)
  await expect(win.locator('.ix-mw-col--collapsed')).toHaveCount(4)
  await expect(win.locator('.ix-mw-col--review')).not.toHaveClass(/ix-mw-col--collapsed/)
  await expect(win.locator('.ix-mw-col--todo .ix-mw-col__name')).toHaveText('To Do')
  // The strips really are strips: the section is far narrower than a column that holds cards.
  const strip = await win.locator('.ix-mw-col--todo').boundingBox()
  const open = await win.locator('.ix-mw-col--review').boundingBox()
  expect(strip!.width).toBeLessThan(open!.width / 2)

  // The section head counts what the board holds, not what the filter left, so the number does not
  // move under a narrowing that only this one board knows about.
  await expect(win.locator('.ix-mw-section__count').first()).toHaveText('3')

  // Clearing the box gives the whole board back.
  await win.getByTestId('jira-filter').fill('')
  await expect(win.locator('.ix-mw-card2')).toHaveCount(3)
  await expect(win.locator('.ix-mw-col--collapsed')).toHaveCount(2)

  await app.close()
})

test('narrowing to one epic keeps only the issues under it', async () => {
  const { app, win } = await launch({ INTERSECT_E2E_JIRA: 'board' })
  await expect(win.locator('.ix-mw-card2')).toHaveCount(3)

  await win.getByTestId('jira-filter-epic').click()
  await win.locator('.ix-msel__pop button', { hasText: 'None' }).click()
  await win.locator('.ix-msel__item', { hasText: 'Platform' }).click()

  await expect(win.locator('.ix-mw-card2 .ix-mw-key')).toHaveText(['FID2507-2'])
  await expect(win.getByTestId('jira-filter-epic')).toHaveText(/1\/3/)

  // The issue under the other epic is gone, and its column with it.
  await expect(win.locator('.ix-mw-col--todo')).toHaveClass(/ix-mw-col--collapsed/)

  await app.close()
})

test('hiding one epic leaves the issues that are under no epic where they were', async () => {
  const { app, win } = await launch({ INTERSECT_E2E_JIRA: 'board' })
  await expect(win.locator('.ix-mw-card2')).toHaveCount(3)

  // The gesture is "hide the Release epic". FID2507-3 is under no epic at all and was never asked
  // about, so it has to stay - on a real board it is the largest group there is.
  await win.getByTestId('jira-filter-epic').click()
  await win.locator('.ix-msel__item', { hasText: 'Release' }).click()

  await expect(win.locator('.ix-mw-card2 .ix-mw-key')).toHaveText(['FID2507-2', 'FID2507-3'])
  await expect(win.getByTestId('jira-filter-epic')).toHaveText(/2\/3/)

  // And they are reachable on their own: ask for exactly the issues under no epic.
  await win.locator('.ix-msel__pop button', { hasText: 'None' }).click()
  await win.locator('.ix-msel__item', { hasText: '(none)' }).click()
  await expect(win.locator('.ix-mw-card2 .ix-mw-key')).toHaveText(['FID2507-3'])

  await app.close()
})

test('Escape puts the chip popover away and hands focus back to its button', async () => {
  const { app, win } = await launch({ INTERSECT_E2E_JIRA: 'board' })
  await expect(win.locator('.ix-mw-card2')).toHaveCount(3)

  await win.getByTestId('jira-filter-epic').click()
  await expect(win.locator('.ix-msel__pop')).toBeVisible()

  await win.keyboard.press('Escape')

  await expect(win.locator('.ix-msel__pop')).toHaveCount(0)
  await expect(win.getByTestId('jira-filter-epic')).toBeFocused()

  await app.close()
})

test('tabbing out of an open chip popover puts it away instead of leaving it over the board', async () => {
  const { app, win } = await launch({ INTERSECT_E2E_JIRA: 'board' })
  await expect(win.locator('.ix-mw-card2')).toHaveCount(3)

  await win.getByTestId('jira-filter-epic').click()
  await expect(win.locator('.ix-msel__pop')).toBeVisible()

  // Walk forward until focus leaves the control: All, None, each checkbox, then out.
  for (let i = 0; i < 8; i++) await win.keyboard.press('Tab')

  await expect(win.locator('.ix-msel__pop')).toHaveCount(0)

  await app.close()
})

test('a filter nothing matches says so rather than showing a board of blank strips', async () => {
  const { app, win } = await launch({ INTERSECT_E2E_JIRA: 'board' })
  await expect(win.locator('.ix-mw-card2')).toHaveCount(3)

  await win.getByTestId('jira-filter').fill('zzzz')

  await expect(win.locator('.ix-mw-card2')).toHaveCount(0)
  await expect(win.locator('.ix-boardfilter__none')).toHaveText('No issues match this filter.')

  await app.close()
})

test('the PR radar groups pull requests and flags new changes after the author pushes', async () => {
  const { app, win } = await launch({ INTERSECT_E2E_ADO: 'radar' })
  const prSection = win.locator('.ix-mw-section', { hasText: 'Pull requests' })

  // The app's own refresh at boot seeds the review watermark for the already-approved PR, so only
  // the first two subgroups exist - nothing is retroactively flagged as changed. Opening My Work
  // adds no second refresh: it asks the same staleness guard, which has just been satisfied.
  await expect(prSection.locator('.ix-mw-subgroup__label')).toHaveText([
    'My PRs waiting to merge',
    'Waiting on my review'
  ])
  await expect(prSection.locator('.ix-mw-section__count')).toHaveText('2')

  // The shared Refresh re-syncs the PRs too; the stub's author has pushed since my approval.
  await win.locator('.ix-mywork__topbar button', { hasText: 'Refresh' }).click()
  await expect(prSection.locator('.ix-mw-subgroup__label')).toHaveText([
    'My PRs waiting to merge',
    'Waiting on my review',
    'New changes since my review'
  ])
  await expect(prSection.locator('.ix-mw-row .ix-mw-title')).toHaveText([
    'Add rate limiting to the sync pipeline',
    'Fix PTY backpressure on large output',
    'Extract the notification preferences screen'
  ])
  await expect(prSection.locator('.ix-mw-status')).toHaveText(['2 approvals', 'Waiting', 'Updated'])
  await expect(prSection.locator('.ix-mw-row .ix-mw-sub').first()).toHaveText(
    'intersect-app · #501 · Jan Lesak'
  )
  await expect(prSection.locator('.ix-mw-section__count')).toHaveText('3')

  await app.close()
})

test('clicking a PR row opens it in the PR Inbox section with the PR selected', async () => {
  const { app, win } = await launch({ INTERSECT_E2E_ADO: 'radar' })

  await win.locator('.ix-mw-row', { hasText: 'Fix PTY backpressure on large output' }).click()

  // The shell switched to the PR Inbox main view and its detail header shows the selected PR.
  await expect(win.locator('.ix-pr-header__title')).toHaveText('Fix PTY backpressure on large output')
  await expect(win.locator('.ix-rail__btn--active')).toContainText('PR Review')

  await app.close()
})

test('with no pull requests needing attention the radar shows a neutral empty message', async () => {
  const { app, win } = await launch({ INTERSECT_E2E_JIRA: 'board' })

  await expect(win.locator('.ix-mw-pr-empty')).toHaveText('No pull requests need your attention.')
  // The Jira half is unaffected by the empty PR radar.
  await expect(win.locator('.ix-mw-card2')).toHaveCount(3)

  await app.close()
})
