import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { addDays, weekStartOf } from '../src/common/week'
import { expect, invokeMenu, launch, openRailSection, tempDir, test, unconfiguredAdo, userDataDir } from './harness'

async function pin(app: ElectronApplication, win: Page) {
  const size = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(940, 600)
    return { outer: window.getSize(), content: window.getContentSize() }
  })
  expect(size.outer).toEqual([940, 600])
  await expect.poll(() => win.evaluate(() => [innerWidth, innerHeight])).toEqual(size.content)
}

async function refresh(app: ElectronApplication, win: Page) {
  await invokeMenu(app, 'palette.open')
  await win.locator('.ix-palette__input').fill('Refresh Time Tracking')
  // On a slow runner the palette's open effect can clear the query after the fill, and Enter then
  // runs whichever command is first in the full list.
  await expect(win.locator('.ix-palette__item--active .ix-palette__title')).toHaveText('Refresh Time Tracking')
  await win.keyboard.press('Enter')
  await expect(win.locator('.ix-palette')).toHaveCount(0)
}

test('daily cards retain edits after resume, cleanup and restart; settings hide and restore history', async () => {
  const profile = userDataDir()
  const projects = tempDir('intersect-daily-snapshots-')
  const folder = join(projects, 'project')
  mkdirSync(folder)
  const path = join(folder, 'session.jsonl')
  const mon = weekStartOf(Date.now())
  const tue = addDays(mon, 1)
  const at = (day: string, minute: number) => new Date(`${day}T09:${String(minute).padStart(2, '0')}:00`).toISOString()
  const record = (day: string, minute: number) => ({ type: 'user', timestamp: at(day, minute),
    cwd: '/synthetic/work/project', gitBranch: 'feature/ABC-12', message: { content: 'Implement daily history' } })
  const records = [{ type: 'ai-title', aiTitle: 'Daily history session' }, record(mon, 0), record(mon, 5), record(tue, 0), record(tue, 6)]
  const write = () => writeFileSync(path, records.map(r => JSON.stringify(r)).join('\n'))
  write()
  writeFileSync(join(folder, 'branchless.jsonl'), [0, 5].map(minute => JSON.stringify({
    type: 'user', timestamp: at(tue, minute), cwd: '/synthetic/other', message: { content: 'Branchless work' }
  })).join('\n'))
  const env = { ...unconfiguredAdo(), INTERSECT_CLAUDE_PROJECTS_DIR: projects }
  const first = await launch(profile, { env })
  await pin(first.app, first.win)
  await openRailSection(first.win, 'Time Tracking', '.ix-tt__board')
  const monday = first.win.locator(`.ix-tt__day[data-day="${mon}"]`)
  const tuesday = first.win.locator(`.ix-tt__day[data-day="${tue}"]`)
  await expect(monday.locator('.ix-tt-card')).toHaveCount(1)
  await expect(tuesday.locator('.ix-tt-card')).toHaveCount(2)
  await expect(monday.locator('.ix-tt-card__dur')).toHaveValue('15m')
  await expect(tuesday.locator('.ix-tt__day-total')).toHaveText('11m')
  await expect(first.win.locator('.ix-tt__total')).toHaveText('26m total')
  await expect(monday.locator('.ix-tt-card__metadata')).toHaveCount(0)
  await expect(monday.locator('.ix-tt-card [title="Resume"]')).toHaveCount(1)
  await expect(tuesday.locator('.ix-tt-card [title="Resume"]')).toHaveCount(2)
  expect(await monday.locator('.ix-tt-card').evaluate(card => card.outerHTML))
    .not.toContain('/synthetic/work/project')
  expect(await monday.locator('.ix-tt-card').evaluate(card => card.outerHTML))
    .not.toContain('feature/ABC-12')
  // Real minimum window: the simplified card cannot widen a column or put controls outside it.
  const geometry = await monday.locator('.ix-tt-card').evaluate(card => {
    const rect = card.getBoundingClientRect()
    return { noOverflow: card.scrollWidth <= card.clientWidth,
      controlsInside: [...card.querySelectorAll('input, button')].every(control => {
        const box = control.getBoundingClientRect()
        return box.left >= rect.left && box.right <= rect.right && box.bottom <= innerHeight
      }) }
  })
  expect(geometry).toEqual({ noOverflow: true, controlsInside: true })
  await monday.getByLabel('Description', { exact: true }).fill('Owner Monday description')
  await monday.getByLabel('Description', { exact: true }).press('Enter')
  await monday.getByLabel('Issue key').fill('OWNER-9')
  await monday.getByLabel('Issue key').press('Enter')
  await monday.getByLabel('Time spent').fill('1m')
  await monday.getByLabel('Time spent').press('Enter')
  await expect(first.win.locator('.ix-tt__total')).toHaveText('12m total')
  records.push(record(tue, 10))
  write()
  await refresh(first.app, first.win)
  await expect(first.win.locator('.ix-tt__total')).toHaveText('16m total')
  await expect(monday.getByLabel('Time spent')).toHaveValue('1m')
  await expect(monday.getByLabel('Description', { exact: true })).toHaveValue('Owner Monday description')
  rmSync(path)
  await refresh(first.app, first.win)
  await expect(first.win.locator('.ix-tt__total')).toHaveText('16m total')
  await expect(monday.locator('.ix-tt-card [title="Resume"]')).toHaveCount(0)
  expect(first.errors).toEqual([])
  await first.app.close()

  const second = await launch(profile, { env })
  await pin(second.app, second.win)
  await openRailSection(second.win, 'Time Tracking', '.ix-tt__board')
  const stored = second.win.locator(`.ix-tt__day[data-day="${mon}"]`)
  await expect(stored.getByLabel('Description', { exact: true })).toHaveValue('Owner Monday description')
  await expect(stored.getByLabel('Issue key')).toHaveValue('OWNER-9')
  await expect(stored.getByLabel('Time spent')).toHaveValue('1m')
  await expect(stored.locator('.ix-tt-card [title="Resume"]')).toHaveCount(0)
  await expect(second.win.locator('.ix-tt__total')).toHaveText('16m total')
  await openRailSection(second.win, 'Settings', '.ix-settings')
  await second.win.locator('.ix-settings__nav-btn', { hasText: 'Time Tracking' }).click()
  await second.win.getByLabel('Excluded path prefixes').fill('/synthetic/work/proj')
  const save = second.win.getByRole('button', { name: 'Save exclusions', exact: true })
  await expect(save).toBeInViewport({ ratio: 1 })
  await save.click()
  await expect(save).toBeEnabled()
  await openRailSection(second.win, 'Time Tracking', '.ix-tt__board')
  await expect(second.win.locator('.ix-tt-card')).toHaveCount(1)
  await expect(second.win.locator('.ix-tt__total')).toHaveText('5m total')
  await openRailSection(second.win, 'Settings', '.ix-settings')
  await second.win.locator('.ix-settings__nav-btn', { hasText: 'Time Tracking' }).click()
  await second.win.getByLabel('Excluded path prefixes').fill('')
  await second.win.getByRole('button', { name: 'Save exclusions', exact: true }).click()
  await openRailSection(second.win, 'Time Tracking', '.ix-tt__board')
  await expect(second.win.locator('.ix-tt-card')).toHaveCount(3)
  await expect(second.win.locator('.ix-tt__total')).toHaveText('16m total')
  await expect(stored.getByLabel('Description', { exact: true })).toHaveValue('Owner Monday description')
  await stored.getByLabel('Description', { exact: true }).fill('Still editable after cleanup')
  await stored.getByLabel('Description', { exact: true }).press('Enter')
  await refresh(second.app, second.win)
  await expect(stored.getByLabel('Description', { exact: true })).toHaveValue('Still editable after cleanup')
  expect(second.errors).toEqual([])
})
