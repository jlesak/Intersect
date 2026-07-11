import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const APP_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js')

/** Launch the app; `ado: 'radar'` boots against the stubbed ADO backend with canned PRs. */
async function launch(ado?: 'radar'): Promise<{ app: ElectronApplication; win: Page; errors: string[] }> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const app = await electron.launch({
    args: [APP_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, INTERSECT_E2E: '1', ...(ado ? { INTERSECT_E2E_ADO: ado } : {}) }
  })
  const win = await app.firstWindow()
  const errors: string[] = []
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  win.on('pageerror', (e) => errors.push(e.message))
  await expect(win.locator('.ix-wordmark__name')).toHaveText('Intersect')
  return { app, win, errors }
}

test('PR Review section renders the empty board and switches back without errors', async () => {
  const { app, win, errors } = await launch()

  const prRail = win.locator('.ix-rail__btn', { hasText: 'PR Review' })
  await expect(prRail).toBeVisible()
  await prRail.click()

  // The board (main area) shows the Sync control and the empty state; the sidebar has no PR list.
  await expect(win.getByTestId('pr-sync')).toBeVisible()
  await expect(win.locator('.ix-empty__hint')).toContainText('Sync to load your pull requests')

  await win.locator('.ix-rail__btn', { hasText: 'Claude Code' }).click()
  await expect(win.locator('.ix-empty__title')).toBeVisible()

  await app.close()
  expect(errors, `renderer console errors:\n${errors.join('\n')}`).toEqual([])
})

test('board shows PRs in action columns after sync, with the rail badge counting my actions', async () => {
  const { app, win } = await launch('radar')

  await win.locator('.ix-rail__btn', { hasText: 'PR Review' }).click()
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

  await win.locator('.ix-rail__btn', { hasText: 'PR Review' }).click()
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

  await win.locator('.ix-rail__btn', { hasText: 'PR Review' }).click()
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

  await win.locator('.ix-rail__btn', { hasText: 'PR Review' }).click()
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

  await win.locator('.ix-rail__btn', { hasText: 'PR Review' }).click()
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

  await win.locator('.ix-rail__btn', { hasText: 'PR Review' }).click()
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
