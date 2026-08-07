import { type ElectronApplication, type Page } from '@playwright/test'
import {
  connectedAdo,
  expect,
  launch as launchApp,
  openRailSection,
  stubOpenExternal,
  test,
  unconfiguredAdo,
  userDataDir
} from './harness'

/**
 * Launch the app; `ado: 'radar'` boots against the stubbed ADO backend with canned PRs.
 *
 * Always on an unconnected machine. These tests count what the canned backend has served by the
 * time they assert, and the app refreshes pull requests by itself only when it has a connection to
 * do it with - so inheriting the developer's credentials would make a Sync click below the second
 * sync on one laptop and the first on another.
 */
async function launch(
  ado?: 'radar'
): Promise<{ app: ElectronApplication; win: Page; errors: string[] }> {
  return launchApp(userDataDir(), {
    env: { ...unconfiguredAdo(), ...(ado ? { INTERSECT_E2E_ADO: ado } : {}) }
  })
}

/**
 * The pull-request page a user opens is composed from the configured organisation, so the two specs
 * about the header's outbound links need a machine that has one. Everything else stays on the
 * unconnected launch above, where sync counts are the thing under test.
 */
const PR_501_WEB_URL = 'https://devops.example/e2e/SPOT/_git/intersect-app/pullrequest/501'

async function launchConnected(): Promise<{
  app: ElectronApplication
  win: Page
  errors: string[]
}> {
  return launchApp(userDataDir(), { env: { ...connectedAdo(), INTERSECT_E2E_ADO: 'radar' } })
}

/** Open PR Review and wait for the board head, which is up whether or not the board has cards. */
async function openPrReview(win: Page): Promise<void> {
  await openRailSection(win, 'PR Review', '.ix-board-head')
}

test('PR Review section renders the empty board and switches back without errors', async () => {
  const { app, win, errors } = await launch()

  await expect(win.locator('.ix-rail__btn', { hasText: 'PR Review' })).toBeVisible()
  await openPrReview(win)

  // The board (main area) shows the Sync control and the empty state; the sidebar has no PR list.
  await expect(win.getByTestId('pr-sync')).toBeVisible()
  await expect(win.locator('.ix-empty__hint')).toContainText('Sync to load your pull requests')

  // Both empty states render .ix-empty__title, so the wait is on Other becoming the active
  // destination - the assertion alone cannot tell the board we left from the one we arrived at.
  await openRailSection(win, 'Other', '.ix-rail__btn--other.ix-rail__btn--active')
  await expect(win.locator('.ix-empty__title')).toBeVisible()

  await app.close()
  expect(errors, `renderer console errors:\n${errors.join('\n')}`).toEqual([])
})

test('board shows PRs in action columns after sync, with the rail badge counting my actions', async () => {
  const { app, win } = await launch('radar')

  await openPrReview(win)
  await win.getByTestId('pr-sync').click()

  // PR 502 (reviewer, no vote) and PR 501 (author, 1 unresolved thread) need my action;
  // PR 503 (reviewer, my vote approved, no other reviewers) is fully approved.
  await expect(win.getByTestId('pr-col-action').getByTestId('pr-card')).toHaveCount(2)
  await expect(win.getByTestId('pr-col-approved').getByTestId('pr-card')).toHaveCount(1)
  await expect(win.getByTestId('pr-col-waiting').getByTestId('pr-card')).toHaveCount(0)
  await expect(win.getByTestId('pr-badge')).toHaveText('2')

  await app.close()
})

test('opening a card shows the detail with the file tree; Escape returns to the board', async () => {
  const { app, win } = await launch('radar')

  await openPrReview(win)
  await win.getByTestId('pr-sync').click()
  await win.getByTestId('pr-card').filter({ hasText: 'Fix PTY backpressure' }).click()

  await expect(win.locator('.ix-pr-header__title')).toHaveText('Fix PTY backpressure on large output')
  await win.getByTestId('pr-tab-files').click()
  // 4 canned changed files in the stub, grouped under a compacted tree.
  await expect(win.getByTestId('tree-file')).toHaveCount(4)

  await win.keyboard.press('Escape')
  await expect(win.getByTestId('pr-board')).toBeVisible()

  await app.close()
})

test('a freshly opened PR lands on the conversation, not on the files', async () => {
  const { app, win } = await launch('radar')

  await openPrReview(win)
  await win.getByTestId('pr-sync').click()
  await win.getByTestId('pr-card').filter({ hasText: 'Add rate limiting' }).click()

  await expect(win.getByTestId('pr-overview')).toBeVisible()
  await expect(win.getByTestId('pr-tab-overview')).toHaveClass(/ix-ptab--active/)
  // The one real thread of PR 501 is there without the user asking for it.
  await expect(win.getByTestId('pr-thread')).toHaveCount(1)

  await app.close()
})

test('the conversation leads with the description, laid out as the author typed it', async () => {
  const { app, win } = await launch('radar')

  await openPrReview(win)
  await win.getByTestId('pr-sync').click()
  await win.getByTestId('pr-card').filter({ hasText: 'Add rate limiting' }).click()

  const description = win.getByTestId('pr-description')
  await expect(description).toContainText('Caps the outbound sync at 25 requests a second.')
  await expect(description).toContainText('token bucket per host')
  // The stylesheet is what keeps the author's line breaks on the screen, and only a real browser
  // can say whether it reached this element.
  expect(await description.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre-wrap')

  // A PR nobody described gets no box rather than an empty one.
  await win.keyboard.press('Escape')
  await win.getByTestId('pr-card').filter({ hasText: 'Fix PTY backpressure' }).click()
  await expect(win.getByTestId('pr-overview')).toBeVisible()
  await expect(win.getByTestId('pr-description')).toHaveCount(0)

  await app.close()
})

test('the detail header copies the PR web link to the clipboard', async () => {
  const { app, win } = await launchConnected()

  await openPrReview(win)
  await win.getByTestId('pr-sync').click()
  await win.getByTestId('pr-card').filter({ hasText: 'Add rate limiting' }).click()

  // Copying writes the real system clipboard, so whatever the developer had in it is put back
  // below rather than quietly lost to a test run.
  const before = await app.evaluate(({ clipboard }) => clipboard.readText())
  await win.getByTestId('pr-copy-link').click()

  // Read back through the main process: this proves the link actually left the app, rather than
  // only that a button exists.
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(PR_501_WEB_URL)
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), before)

  await app.close()
})

test('Open in Azure DevOps hands the browsable pull-request page to the system browser', async () => {
  const { app, win } = await launchConnected()
  const opened = await stubOpenExternal(app)

  await openPrReview(win)
  await win.getByTestId('pr-sync').click()
  await win.getByTestId('pr-card').filter({ hasText: 'Add rate limiting' }).click()
  await win.getByTestId('pr-open-external').click()

  // The whole chain has to hold for this to arrive: a web address rather than the REST resource the
  // payload carried, and a main-process allowlist that admits the configured Azure DevOps server.
  await expect.poll(opened).toEqual([PR_501_WEB_URL])

  await app.close()
})

test('a machine with no Azure DevOps organisation offers no link to open', async () => {
  const { app, win } = await launch('radar')

  await openPrReview(win)
  await win.getByTestId('pr-sync').click()
  await win.getByTestId('pr-card').filter({ hasText: 'Add rate limiting' }).click()

  // Nothing composes a page address without the organisation, so the header says so by being dead
  // rather than by opening the browser on a broken URL.
  await expect(win.getByTestId('pr-open-external')).toBeDisabled()
  await expect(win.getByTestId('pr-copy-link')).toBeDisabled()

  await app.close()
})

test('the diff carries its inline threads on a PR the user took straight to Files', async () => {
  const { app, win } = await launch('radar')

  await openPrReview(win)
  await win.getByTestId('pr-sync').click()
  await win.getByTestId('pr-card').filter({ hasText: 'Add rate limiting' }).click()
  await win.getByTestId('pr-tab-files').click()
  await win.getByTestId('tree-file').filter({ hasText: 'rateLimiter.ts' }).first().click()

  // The thread anchored to this file renders as a Monaco view zone under its line, without the
  // conversation ever having been opened.
  await expect(win.getByTestId('pr-thread')).toContainText('Should the limit be configurable?')

  await app.close()
})

test('collapsing a tree directory hides its files and shows the file count', async () => {
  const { app, win } = await launch('radar')

  await openPrReview(win)
  await win.getByTestId('pr-sync').click()
  await win.getByTestId('pr-card').filter({ hasText: 'Fix PTY backpressure' }).click()
  await win.getByTestId('pr-tab-files').click()

  const before = await win.getByTestId('tree-file').count()
  const firstDir = win.getByTestId('tree-dir').first()
  await firstDir.click()
  const after = await win.getByTestId('tree-file').count()
  expect(after).toBeLessThan(before)
  await expect(firstDir.locator('.ix-tree__count')).toBeVisible()
  // Expanding restores the full list.
  await firstDir.click()
  await expect(win.getByTestId('tree-file')).toHaveCount(before)

  await app.close()
})

test('overview lists threads, hides system messages, and resolving folds a thread away', async () => {
  const { app, win } = await launch('radar')

  await openPrReview(win)
  await win.getByTestId('pr-sync').click()
  // PR 501 carries one real active thread plus one system thread (hidden everywhere).
  await win.getByTestId('pr-card').filter({ hasText: 'Add rate limiting' }).click()

  await expect(win.getByTestId('pr-thread')).toHaveCount(1)
  await expect(win.getByTestId('pr-overview')).not.toContainText('Policy status has been updated')
  // Nothing is resolved yet, so there is no settled section to fold.
  await expect(win.getByTestId('pr-resolved-toggle')).toHaveCount(0)

  await win.getByTestId('pr-thread-toggle').click()

  // The thread leaves the list it was asking something of, and becomes a counted, dimmed section.
  const resolved = win.locator('.ix-overview__resolved')
  await expect(win.getByTestId('pr-resolved-toggle')).toContainText('1')
  await expect(win.getByTestId('pr-thread')).toHaveCount(0)

  await win.getByTestId('pr-resolved-toggle').click()
  await expect(resolved.getByTestId('pr-thread')).toHaveCount(1)
  await expect(resolved.getByTestId('pr-thread')).toContainText('Should the limit be configurable?')

  await app.close()
})

test('replying appends to the thread immediately', async () => {
  const { app, win } = await launch('radar')

  await openPrReview(win)
  await win.getByTestId('pr-sync').click()
  await win.getByTestId('pr-card').filter({ hasText: 'Add rate limiting' }).click()
  await win.getByTestId('pr-tab-overview').click()

  const thread = win.getByTestId('pr-thread').first()
  await expect(thread.locator('.ix-thread__comment')).toHaveCount(1)
  await thread.getByTestId('pr-thread-reply').fill('Fixed in the next push.')
  await thread.getByTestId('pr-thread-reply-send').click()
  await expect(thread.locator('.ix-thread__comment')).toHaveCount(2)
  await expect(thread).toContainText('Fixed in the next push.')

  await app.close()
})

test('a PR-level comment publishes from the overview composer', async () => {
  const { app, win } = await launch('radar')

  await openPrReview(win)
  await win.getByTestId('pr-sync').click()
  await win.getByTestId('pr-card').filter({ hasText: 'Fix PTY backpressure' }).click()
  await win.getByTestId('pr-tab-overview').click()

  await expect(win.getByTestId('pr-thread')).toHaveCount(0)
  await win.getByTestId('pr-add-comment').click()
  await win.getByTestId('pr-composer-input').fill('Please rebase onto main.')
  await win.getByTestId('pr-composer-submit').click()

  await expect(win.getByTestId('pr-thread')).toHaveCount(1)
  await expect(win.getByTestId('pr-thread')).toContainText('Please rebase onto main.')

  await app.close()
})
