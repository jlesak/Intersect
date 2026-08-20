import { type Locator, type Page } from '@playwright/test'
import {
  addWorkspace,
  expect,
  launch,
  openRailSection,
  stubQuitConfirm,
  tempDir,
  test,
  userDataDir
} from './harness'

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

async function openTodo(win: Page): Promise<void> {
  await openRailSection(win, 'TODO', '.ix-todo')
}

// Only the main list's rows sit directly under .ix-todo; the Done drawer's rows are nested in it.
const openRows = (win: Page): Locator => win.locator('.ix-todo > .ix-todo__list > .ix-todo-item')
const doneRows = (win: Page): Locator => win.locator('.ix-todo__done-drawer .ix-todo-item')

/** Add a task through the add row, optionally picking a due day first. Enter submits. */
async function addTask(
  win: Page,
  text: string,
  opts: { dueDay?: string } = {}
): Promise<void> {
  if (opts.dueDay) {
    await win.locator('.ix-btn[title="Add due date"]').click()
    await win.locator('.ix-todo__date').fill(opts.dueDay)
  }
  const input = win.getByPlaceholder('Add a task… (Enter)')
  await input.fill(text)
  await input.press('Enter')
}

/** Drag a row's grip to the top half of the target row. */
async function dragRowAbove(win: Page, row: Locator, target: Locator): Promise<void> {
  const handle = row.locator('.ix-todo-item__drag')
  await handle.hover()
  await win.mouse.down()
  const box = (await target.boundingBox())!
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 })
  await win.mouse.move(box.x + box.width / 2, box.y + 3, { steps: 4 })
  await win.mouse.up()
}

test('adds tasks with Enter, with optional due dates, and marks overdue ones', async () => {
  const { win } = await launch(userDataDir())
  await openTodo(win)

  // Fresh profile: empty state, no done tasks.
  await expect(win.locator('.ix-todo__empty')).toHaveText('No tasks yet - add one above.')
  await expect(win.locator('.ix-todo__done-link')).toHaveText('Show done (0)')
  await expect(win.locator('.ix-todo-prio-picker, .ix-todo-item__prio')).toHaveCount(0)

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

  // Due dates never override insertion/manual order.
  await expect(openRows(win).locator('.ix-todo-item__text')).toHaveText([
    'Ask Marek about the review',
    'Check the deploy logs',
    'Update the dependencies'
  ])
})

test('a click only selects a row; the editor waits for a double-click', async () => {
  const { win } = await launch(userDataDir())
  await openTodo(win)
  await addTask(win, 'Review the migration')

  const row = openRows(win).first()
  await row.click()
  await expect(row).toHaveClass(/ix-todo-item--selected/)
  await expect(win.locator('.ix-todo-item--editing')).toHaveCount(0)

  await row.dblclick()
  await expect(win.locator('.ix-todo-item--editing')).toHaveCount(1)
  await expect(win.locator('.ix-todo-item--selected')).toHaveCount(0)
})

test('a right-click raises the task menu, and Delete from it removes the row', async () => {
  const { win } = await launch(userDataDir())
  await openTodo(win)
  await addTask(win, 'keep me')
  await addTask(win, 'menu victim')

  await openRows(win).filter({ hasText: 'menu victim' }).click({ button: 'right' })
  await expect(win.locator('.ix-menu__item')).toHaveText([
    'Start session',
    'Copy task',
    'Edit',
    'Delete'
  ])

  await win.locator('.ix-menu__item', { hasText: 'Delete' }).click()
  await expect(win.locator('.ix-menu')).toHaveCount(0)
  await expect(openRows(win).locator('.ix-todo-item__text')).toHaveText(['keep me'])
})

test('inline edit keeps text, description, and optional due date without exposing priority', async () => {
  const { win } = await launch(userDataDir())
  await openTodo(win)
  await addTask(win, 'draft')

  const row = openRows(win).filter({ hasText: 'draft' })
  await row.hover()
  await row.locator('.ix-iconbtn[title="Edit"]').click()
  await expect(win.locator('.ix-todo-prio-picker, [title^="Priority "]')).toHaveCount(0)
  const editor = openRows(win).filter({ has: win.getByPlaceholder('Task') })
  await editor.getByPlaceholder('Task').fill('edited task')
  await editor.getByPlaceholder('Description').fill('kept detail')
  await editor.locator('input[type="date"]').fill(dayFromToday(2))
  await editor.getByRole('button', { name: 'Save' }).click()

  const edited = openRows(win).filter({ hasText: 'edited task' })
  await expect(edited.locator('.ix-todo-item__description')).toHaveText('kept detail')
  await expect(edited.locator('.ix-todo-item__due')).toBeVisible()
})

test('checking hides a task in the Done drawer and unchecking returns it to the end', async () => {
  const { win } = await launch(userDataDir())
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
})

test('delete works from the main list and from the Done drawer', async () => {
  const { win } = await launch(userDataDir())
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
})

test('pointer and keyboard reorder persist across renderer reload and app restart', async () => {
  const profileDir = userDataDir()
  const first = await launch(profileDir)
  await openTodo(first.win)

  await addTask(first.win, 'first')
  await addTask(first.win, 'second', { dueDay: dayFromToday(-2) })
  await addTask(first.win, 'third', { dueDay: dayFromToday(2) })
  await expect(openRows(first.win).locator('.ix-todo-item__text')).toHaveText([
    'first',
    'second',
    'third'
  ])

  await dragRowAbove(first.win, openRows(first.win).nth(2), openRows(first.win).nth(0))
  await expect(openRows(first.win).locator('.ix-todo-item__text')).toHaveText([
    'third',
    'first',
    'second'
  ])

  const secondHandle = openRows(first.win)
    .filter({ hasText: 'second' })
    .getByRole('button', { name: /Move second/ })
  await secondHandle.focus()
  await secondHandle.press('ArrowUp')
  await expect(secondHandle).toBeFocused()
  await secondHandle.press('ArrowUp')
  await expect(secondHandle).toBeFocused()
  await expect(openRows(first.win).locator('.ix-todo-item__text')).toHaveText([
    'second',
    'third',
    'first'
  ])
  await expect(first.win.locator('.ix-todo__reorder-status')).toHaveText(
    'Moved second to position 1 of 3.'
  )

  await first.win.reload()
  await openTodo(first.win)
  await expect(openRows(first.win).locator('.ix-todo-item__text')).toHaveText([
    'second',
    'third',
    'first'
  ])
  await first.app.close()

  const second = await launch(profileDir)
  await openTodo(second.win)
  await expect(openRows(second.win).locator('.ix-todo-item__text')).toHaveText([
    'second',
    'third',
    'first'
  ])
})

test('a row starts a Claude session that carries the task as its work item', async () => {
  const profileDir = userDataDir()
  const wsDir = tempDir('todo-ws-')
  const { app, win } = await launch(profileDir, { openOther: true })
  await addWorkspace(win, app, wsDir)
  await stubQuitConfirm(app)
  await openTodo(win)
  await addTask(win, 'Draft the migration plan')

  const row = openRows(win).first()
  await row.hover()
  await row.getByRole('button', { name: 'Start session' }).click()

  // The tab and its terminal exist whether or not `claude` is installed on this machine.
  await expect(win.locator('.ix-tab')).toHaveCount(1)
  await expect(win.locator('.ix-tab__workitem')).toHaveText('TODO')

  // A live session makes quitting prompt; this close walks the real teardown with it answered.
  await app.close()
})
