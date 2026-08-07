import { type ElectronApplication, type Page } from '@playwright/test'
import {
  expect,
  launch as launchApp,
  openRailSection,
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
  await expect(win.getByTestId('pr-tab-files')).toBeVisible()
  // 4 canned changed files in the stub, grouped under a compacted tree.
  await expect(win.getByTestId('tree-file')).toHaveCount(4)

  await win.keyboard.press('Escape')
  await expect(win.getByTestId('pr-board')).toBeVisible()

  await app.close()
})

test('collapsing a tree directory hides its files and shows the file count', async () => {
  const { app, win } = await launch('radar')

  await openPrReview(win)
  await win.getByTestId('pr-sync').click()
  await win.getByTestId('pr-card').filter({ hasText: 'Fix PTY backpressure' }).click()

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

test('overview lists threads, hides system messages, and resolve moves a thread out of Active', async () => {
  const { app, win } = await launch('radar')

  await openPrReview(win)
  await win.getByTestId('pr-sync').click()
  // PR 501 carries one real active thread plus one system thread (hidden everywhere).
  await win.getByTestId('pr-card').filter({ hasText: 'Add rate limiting' }).click()
  await win.getByTestId('pr-tab-overview').click()

  await expect(win.getByTestId('pr-thread')).toHaveCount(1)
  await expect(win.getByTestId('pr-overview')).not.toContainText('Policy status has been updated')

  // Resolve: the active filter now shows nothing; the resolved filter shows the thread.
  await win.getByTestId('pr-thread-toggle').click()
  await expect(win.getByTestId('pr-thread')).toHaveCount(0)
  await win.getByTestId('pr-thread-filter').selectOption('resolved')
  await expect(win.getByTestId('pr-thread')).toHaveCount(1)

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
