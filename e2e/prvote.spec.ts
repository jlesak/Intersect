import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const APP_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js')

/** Launch the app against the stubbed ADO backend in radar mode (see adoE2eStub). */
async function launch(): Promise<{ app: ElectronApplication; win: Page }> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const app = await electron.launch({
    args: [APP_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, INTERSECT_E2E: '1', INTERSECT_E2E_ADO: 'radar' }
  })
  const win = await app.firstWindow()
  return { app, win }
}

test('voting on a reviewed PR activates the clicked button and survives a re-sync', async () => {
  const { app, win } = await launch()

  // Open PR 502 (I review it, no vote yet) from the My Work radar row.
  await win.locator('.ix-mw-row', { hasText: 'Fix PTY backpressure on large output' }).click()
  await expect(win.locator('.ix-pr-header__title')).toHaveText('Fix PTY backpressure on large output')

  // The vote group renders with all three options and nothing active.
  const group = win.locator('.ix-pr-vote-group')
  await expect(group).toBeVisible()
  await expect(group.locator('.ix-pr-vote-btn')).toHaveCount(3)
  await expect(group.locator('[class*="ix-pr-vote-btn--active-"]')).toHaveCount(0)
  await expect(group.getByRole('button', { name: 'Approve+' })).toHaveAttribute(
    'title',
    'Approve with suggestions'
  )

  // A click casts the vote immediately - no confirmation step exists - and activates the button.
  await group.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(group.locator('.ix-pr-vote-btn--active-approved')).toHaveCount(1)
  await expect(group.locator('.ix-pr-vote-btn--active-approved')).toHaveText(/Approve/)

  // A full re-sync round-trips the stub's mutated PR; the active vote must persist.
  await win.locator('.ix-btn', { hasText: 'Sync' }).click()
  await expect(group.locator('.ix-pr-vote-btn--active-approved')).toHaveCount(1)

  await app.close()
})

test('switching my vote moves the active state to the newly clicked button', async () => {
  const { app, win } = await launch()

  await win.locator('.ix-mw-row', { hasText: 'Fix PTY backpressure on large output' }).click()
  const group = win.locator('.ix-pr-vote-group')

  await group.getByRole('button', { name: 'Wait for author', exact: true }).click()
  await expect(group.locator('.ix-pr-vote-btn--active-waiting')).toHaveCount(1)

  await group.getByRole('button', { name: 'Approve+' }).click()
  await expect(group.locator('.ix-pr-vote-btn--active-suggestions')).toHaveCount(1)
  await expect(group.locator('.ix-pr-vote-btn--active-waiting')).toHaveCount(0)

  await app.close()
})

test('an already-voted PR reflects my standing vote when opened', async () => {
  const { app, win } = await launch()

  // PR 503 comes from the stub with my vote already 'approved'.
  await win.locator('.ix-rail__btn', { hasText: 'PR Review' }).click()
  await win.locator('.ix-pr-row', { hasText: 'Extract the notification preferences screen' }).click()
  await expect(win.locator('.ix-pr-header__title')).toHaveText(
    'Extract the notification preferences screen'
  )
  await expect(
    win.locator('.ix-pr-vote-group .ix-pr-vote-btn--active-approved')
  ).toHaveCount(1)

  await app.close()
})

test('the vote group is absent on a PR where my reviewer identity is not resolvable', async () => {
  const { app, win } = await launch()

  // PR 501 is authored by me with no reviewer entry of mine - there is nothing to vote with.
  await win.locator('.ix-mw-row', { hasText: 'Add rate limiting to the sync pipeline' }).click()
  await expect(win.locator('.ix-pr-header__title')).toHaveText('Add rate limiting to the sync pipeline')
  await expect(win.locator('.ix-pr-vote-group')).toHaveCount(0)
  // The rest of the header (the review action) still renders.
  await expect(win.locator('.ix-btn', { hasText: 'Review with Claude Code' })).toBeVisible()

  await app.close()
})
