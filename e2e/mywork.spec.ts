import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const APP_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js')

/** Launch the app with the stubbed My Work backends in the given modes (see jiraE2eStub / adoE2eStub). */
async function launch(
  env: Record<string, string>,
  userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
): Promise<{ app: ElectronApplication; win: Page; userDataDir: string }> {
  const app = await electron.launch({
    args: [APP_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, INTERSECT_E2E: '1', ...env }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.ix-wordmark__name')
  // Boot lands on Claude Code, not My Work; switch to the section these tests exercise.
  await win.locator('.ix-rail__btn', { hasText: 'My Work' }).click()
  return { app, win, userDataDir }
}

test('with no saved session, opening My Work starts the SSO login and then loads the board', async () => {
  const { app, win } = await launch({ INTERSECT_E2E_JIRA: 'auth' })

  // Opening My Work with the auth failure flips the section into the sign-in state.
  await expect(win.locator('.ix-mw-loading')).toContainText('Complete the SSO login')

  // The stub login succeeds and the automatic re-fetch renders the sample board.
  await expect(win.locator('.ix-mw-card2')).toHaveCount(3)
  await expect(win.locator('.ix-mw-col--todo .ix-mw-card2 .ix-mw-key')).toHaveText('FID2507-1')
  await expect(win.locator('.ix-mw-col--progress .ix-mw-card2 .ix-mw-key')).toHaveText('FID2507-2')
  await expect(win.locator('.ix-mw-col--review .ix-mw-card2 .ix-mw-key')).toHaveText('FID2507-3')
  await expect(win.locator('.ix-mw-section__count')).toHaveText('3')

  await app.close()
})

test('an abandoned login shows the auth error card with a log-in action', async () => {
  const { app, win } = await launch({
    INTERSECT_E2E_JIRA: 'auth',
    INTERSECT_E2E_JIRA_LOGIN: 'fail'
  })

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
  const second = await launch({ INTERSECT_E2E_JIRA: 'error' }, first.userDataDir)
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

test('the PR radar groups pull requests and flags new changes after the author pushes', async () => {
  const { app, win } = await launch({ INTERSECT_E2E_ADO: 'radar' })
  const prSection = win.locator('.ix-mw-section', { hasText: 'Pull requests' })

  // The boot sync seeds the review watermark for the already-approved PR, so only the first two
  // subgroups exist - nothing is retroactively flagged as changed.
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
