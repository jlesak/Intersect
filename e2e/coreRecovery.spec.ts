import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ElectronApplication } from '@playwright/test'
import { assertCoreHealthy, expect, launch, openRailSection, test, userDataDir } from './harness'

/**
 * A database that fails every boot (#117): the failure card must say so, and give the user a way
 * out that does not repeat the failing step.
 */

const SET_ASIDE_DB = /^intersect-set-aside-\d{8}-\d{6}\.db$/

/** A profile whose database already has a table migration 1 creates, so migration 1 throws. */
function profileWithFailingMigration(): string {
  const dir = userDataDir()
  const db = new DatabaseSync(join(dir, 'intersect.db'))
  db.exec('CREATE TABLE workspaces(x)')
  db.close()
  return dir
}

/** Replace the file-manager launch with a recorder, and answer with what it has been handed. */
async function stubOpenPath(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as unknown as { __openedPaths: string[] }).__openedPaths = opened
    ;(shell as unknown as { openPath: unknown }).openPath = async (path: string) => {
      opened.push(path)
      return ''
    }
  })
  return () =>
    app.evaluate(() => (globalThis as unknown as { __openedPaths: string[] }).__openedPaths)
}

test('a failing migration offers reveal and start fresh, and starting fresh brings the app up', async () => {
  const profile = profileWithFailingMigration()
  const { app, win } = await launch(profile, { expectCoreFailure: true })
  // The app's minimum window size. The card and its confirmation are the only way out, so they
  // must work in the smallest window the user can have, not just in the roomy default one.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 600))
  await expect
    .poll(() => win.evaluate(() => [window.innerWidth, window.innerHeight <= 600]))
    .toEqual([940, true])

  const card = win.locator('.ix-core-failure')
  const headline = card.getByRole('heading', { name: 'Intersect could not open its database' })
  await expect(headline).toBeVisible({ timeout: 20_000 })
  await expect(card.locator('.ix-core-failure__reason').first()).toContainText('migration 1')
  await expect(card.getByRole('button')).toHaveText([
    'Retry',
    'Quit Intersect',
    'Restart Intersect',
    'Reveal data folder',
    'Set database aside and start fresh'
  ])

  // Retry repeats the failing step and sets nothing aside. Waiting for the card to leave and come
  // back is what proves the retry ran, rather than the check passing before it started.
  await card.getByRole('button', { name: 'Retry' }).click()
  await expect(headline).toBeHidden()
  await expect(headline).toBeVisible({ timeout: 20_000 })
  expect(readdirSync(profile).filter((n) => SET_ASIDE_DB.test(n))).toEqual([])

  const openedPaths = await stubOpenPath(app)
  await card.getByRole('button', { name: 'Reveal data folder' }).click()
  await expect.poll(async () => (await openedPaths()).map((p) => realpathSync(p))).toEqual([
    realpathSync(profile)
  ])

  await card.getByRole('button', { name: 'Set database aside and start fresh' }).click()
  // The whole confirmation sits inside the window: its title readable, its confirm button
  // reachable without the user having to think of enlarging the window.
  const dialog = win.getByRole('dialog')
  const confirm = dialog.getByRole('button', { name: 'Set aside and start fresh' })
  const viewportHeight = await win.evaluate(() => window.innerHeight)
  const dialogBox = (await dialog.boundingBox())!
  const confirmBox = (await confirm.boundingBox())!
  expect(dialogBox.y).toBeGreaterThanOrEqual(0)
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(viewportHeight)
  expect(confirmBox.y + confirmBox.height).toBeLessThanOrEqual(viewportHeight)
  await confirm.click()
  await expect(card).toHaveCount(0, { timeout: 20_000 })
  await assertCoreHealthy(win)

  // The core really serves requests on the fresh database.
  await openRailSection(win, 'TODO', '.ix-todo')
  const input = win.getByPlaceholder('Add a task… (Enter)')
  await input.fill('after a fresh start')
  await input.press('Enter')
  await expect(win.locator('.ix-todo-item', { hasText: 'after a fresh start' })).toBeVisible()

  // The old database was renamed, not deleted, and a new one took its place.
  const setAside = readdirSync(profile).filter((n) => SET_ASIDE_DB.test(n))
  expect(setAside).toHaveLength(1)
  expect(existsSync(join(profile, 'intersect.db'))).toBe(true)
  const old = new DatabaseSync(join(profile, setAside[0]))
  try {
    const columns = (old.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(columns).toEqual(['x'])
  } finally {
    old.close()
  }
})
