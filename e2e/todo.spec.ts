import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { TodoPriority } from '@common/domain'

const APP_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js')

/** The local `yyyy-mm-dd` day key of a Date (mirrors the app's local-calendar due days). */
function dayKey(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The day key `offset` days from today, computed at test runtime. */
function dayFromToday(offset: number): string {
  const now = new Date()
  return dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset))
}

async function launch(userDataDir: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: [APP_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, INTERSECT_E2E: '1' }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.ix-wordmark__name')
  return { app, win }
}

async function openTodo(win: Page): Promise<void> {
  await win.locator('.ix-rail__btn', { hasText: 'TODO' }).click()
  await win.locator('.ix-todo').waitFor()
}

// Only the main list's rows sit directly under .ix-todo; the Done drawer's rows are nested in it.
const openRows = (win: Page): Locator => win.locator('.ix-todo > .ix-todo__list > .ix-todo-item')
const doneRows = (win: Page): Locator => win.locator('.ix-todo__done-drawer .ix-todo-item')

/**
 * Add a task through the add row, optionally picking a due day and/or a priority first (the
 * picker defaults to P4, so only non-default priorities need a click). Enter submits.
 */
async function addTask(
  win: Page,
  text: string,
  opts: { dueDay?: string; priority?: TodoPriority } = {}
): Promise<void> {
  if (opts.priority !== undefined && opts.priority !== 4) {
    await win.locator(`.ix-todo__add .ix-todo-prio-picker__chip[title="Priority ${opts.priority}"]`).click()
  }
  if (opts.dueDay) {
    await win.locator('.ix-btn[title="Add due date"]').click()
    await win.locator('.ix-todo__date').fill(opts.dueDay)
  }
  const input = win.getByPlaceholder('Add a task… (Enter)')
  await input.fill(text)
  await input.press('Enter')
}

test('adds tasks with Enter, with optional due dates, and marks overdue ones', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const { app, win } = await launch(userDataDir)
  await openTodo(win)

  // Fresh profile: empty state, no done tasks.
  await expect(win.locator('.ix-todo__empty')).toHaveText('No tasks yet - add one above.')
  await expect(win.locator('.ix-todo__done-link')).toHaveText('Show done (0)')

  // Plain task: Enter adds it and clears the input.
  await addTask(win, 'Ask Marek about the review')
  await expect(openRows(win)).toHaveCount(1)
  await expect(win.getByPlaceholder('Add a task… (Enter)')).toHaveValue('')
  await expect(win.locator('.ix-todo__empty')).toHaveCount(0)

  // Task due tomorrow: the date input appears on demand and collapses after submit.
  await addTask(win, 'Check the deploy logs', { dueDay: dayFromToday(1) })
  await expect(win.locator('.ix-todo__date')).toHaveCount(0)
  await expect(openRows(win)).toHaveCount(2)
  const tomorrowRow = openRows(win).filter({ hasText: 'Check the deploy logs' })
  await expect(tomorrowRow.locator('.ix-todo-item__due')).toHaveText(/tomorrow/)
  await expect(tomorrowRow.locator('.ix-todo-item__due--overdue')).toHaveCount(0)

  // Task due yesterday: labeled and styled as overdue.
  await addTask(win, 'Update the dependencies', { dueDay: dayFromToday(-1) })
  const overdueRow = openRows(win).filter({ hasText: 'Update the dependencies' })
  await expect(overdueRow.locator('.ix-todo-item__due--overdue')).toHaveText(/yesterday/)

  // All three share the same (default) priority, so they are ordered by due day ascending with
  // the no-due-date task last - not by insertion order.
  await expect(openRows(win).locator('.ix-todo-item__text')).toHaveText([
    'Update the dependencies',
    'Check the deploy logs',
    'Ask Marek about the review'
  ])

  await app.close()
})

test('checking hides a task in the Done drawer and unchecking returns it to the end', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const { app, win } = await launch(userDataDir)
  await openTodo(win)

  await addTask(win, 'alpha')
  await addTask(win, 'beta')
  await addTask(win, 'gamma')

  // Check alpha: it leaves the main list; the drawer stays hidden but the toggle counts it.
  await openRows(win).filter({ hasText: 'alpha' }).locator('.ix-todo-item__check').click()
  await expect(openRows(win).locator('.ix-todo-item__text')).toHaveText(['beta', 'gamma'])
  await expect(win.locator('.ix-todo__done-drawer')).toHaveCount(0)
  await expect(win.locator('.ix-todo__done-link')).toHaveText('Show done (1)')

  // The toggle reveals the drawer with the done row (filled checkbox, struck text).
  await win.locator('.ix-todo__done-link').click()
  await expect(win.locator('.ix-todo__done-link')).toHaveText('Hide done')
  await expect(win.locator('.ix-todo__done-title')).toHaveText('Done')
  await expect(doneRows(win)).toHaveCount(1)
  await expect(doneRows(win).first()).toHaveClass(/ix-todo-item--done/)
  await expect(doneRows(win).locator('.ix-todo-item__check')).toHaveText('✓')

  // Unchecking from the drawer returns the task to the END of the open list.
  await doneRows(win).locator('.ix-todo-item__check').click()
  await expect(openRows(win).locator('.ix-todo-item__text')).toHaveText(['beta', 'gamma', 'alpha'])
  await expect(doneRows(win)).toHaveCount(0)

  // Hiding the drawer flips the link back to the count.
  await win.locator('.ix-todo__done-link').click()
  await expect(win.locator('.ix-todo__done-drawer')).toHaveCount(0)
  await expect(win.locator('.ix-todo__done-link')).toHaveText('Show done (0)')

  await app.close()
})

test('delete works from the main list and from the Done drawer', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const { app, win } = await launch(userDataDir)
  await openTodo(win)

  await addTask(win, 'keep me')
  await addTask(win, 'delete me open')
  await addTask(win, 'delete me done')

  // Delete an open task (the action shows on hover).
  const openVictim = openRows(win).filter({ hasText: 'delete me open' })
  await openVictim.hover()
  await openVictim.locator('.ix-iconbtn[title="Delete"]').click()
  await expect(openRows(win).locator('.ix-todo-item__text')).toHaveText(['keep me', 'delete me done'])

  // Check the other one, then delete it from the drawer.
  await openRows(win).filter({ hasText: 'delete me done' }).locator('.ix-todo-item__check').click()
  await win.locator('.ix-todo__done-link').click()
  const doneVictim = doneRows(win).filter({ hasText: 'delete me done' })
  await doneVictim.hover()
  await doneVictim.locator('.ix-iconbtn[title="Delete"]').click()
  await expect(doneRows(win)).toHaveCount(0)
  await expect(openRows(win).locator('.ix-todo-item__text')).toHaveText(['keep me'])

  await app.close()
})

test('open tasks are auto-sorted by priority, then due day, then creation order, and the order survives a relaunch', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const first = await launch(userDataDir)
  await openTodo(first.win)

  // Same (default P4) priority, no due dates: falls back to creation order.
  await addTask(first.win, 'first created')
  await addTask(first.win, 'second created')
  await expect(openRows(first.win).locator('.ix-todo-item__text')).toHaveText([
    'first created',
    'second created'
  ])

  // A P1 task added last still sorts to the very top - priority beats creation order.
  await addTask(first.win, 'urgent', { priority: 1 })
  await expect(openRows(first.win).locator('.ix-todo-item__text')).toHaveText([
    'urgent',
    'first created',
    'second created'
  ])
  const urgentRow = openRows(first.win).filter({ hasText: 'urgent' })
  await expect(urgentRow.locator('.ix-todo-item__check')).toHaveClass(/--p1/)
  await expect(urgentRow.locator('.ix-todo-item__prio')).toHaveText('P1')

  // Within a shared priority, an earlier due day sorts first and no due day sorts last.
  await addTask(first.win, 'due later', { priority: 2, dueDay: dayFromToday(5) })
  await addTask(first.win, 'due sooner', { priority: 2, dueDay: dayFromToday(1) })
  await addTask(first.win, 'no due date', { priority: 2 })
  await expect(openRows(first.win).locator('.ix-todo-item__text')).toHaveText([
    'urgent',
    'due sooner',
    'due later',
    'no due date',
    'first created',
    'second created'
  ])
  await first.app.close()

  // Same profile: the same tasks re-sort identically on the next boot - the order is derived from
  // priority and due day every time, not a manually persisted position.
  const second = await launch(userDataDir)
  await openTodo(second.win)
  await expect(openRows(second.win).locator('.ix-todo-item__text')).toHaveText([
    'urgent',
    'due sooner',
    'due later',
    'no due date',
    'first created',
    'second created'
  ])
  await second.app.close()
})
