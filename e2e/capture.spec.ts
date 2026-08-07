import { type ElectronApplication, type Page } from '@playwright/test'
import { expect, invokeMenu, launch, openRailSection, test, userDataDir } from './harness'

/**
 * Quick capture end to end. Each case types the whole thing into the palette and then goes and
 * looks at the slice that was supposed to receive it - the capture crosses the palette, a shared
 * registry, a feature store, the preload bridge, an IPC channel and the database, and only the
 * far end proves it arrived.
 */
async function capture(app: ElectronApplication, win: Page, line: string): Promise<void> {
  await invokeMenu(app, 'palette.open')
  await win.locator('.ix-palette__input').fill(line)
  await win.keyboard.press('Enter')
  await expect(win.locator('.ix-palette')).toHaveCount(0)
}

test('the palette advertises the capture prefixes and previews before acting', async () => {
  const { app, win } = await launch(userDataDir())

  await invokeMenu(app, 'palette.open')
  const prefixes = win.locator('.ix-palette__prefixes')
  await expect(prefixes).toContainText('todo:')
  await expect(prefixes).toContainText('time:')
  await expect(prefixes).toContainText('1:1:')

  // The prefix on its own says what it is for and offers nothing to run.
  await win.locator('.ix-palette__input').fill('todo:')
  await expect(win.locator('.ix-palette__capture-hint')).toContainText('Add a task')
  await expect(win.locator('.ix-palette__item')).toHaveCount(0)

  // Enter here must be a no-op: there is nothing to write down yet.
  await win.keyboard.press('Enter')
  await expect(win.locator('.ix-palette')).toBeVisible()

  // With something to act on, the palette says what it would do before it does it.
  await win.locator('.ix-palette__input').fill('todo: call the vendor tomorrow')
  await expect(win.locator('.ix-palette__capture .ix-palette__title')).toHaveText(
    'Add task "call the vendor", due tomorrow'
  )

  await app.close()
})

test('"todo:" writes a task with the due day its wording named', async () => {
  const { app, win } = await launch(userDataDir())

  await capture(app, win, 'todo: call the vendor tomorrow')
  await expect(win.locator('.ix-toast')).toContainText('Task added: call the vendor, due tomorrow')

  // The list is the proof, not the toast: the row exists, its text lost the date word, and the
  // due day the wording named is the one that was stored.
  await openRailSection(win, 'TODO', '.ix-todo')
  const row = win.locator('.ix-todo > .ix-todo__list > .ix-todo-item')
  await expect(row).toHaveCount(1)
  await expect(row.locator('.ix-todo-item__text')).toHaveText('call the vendor')
  await expect(row.locator('.ix-todo-item__due')).toHaveText('tomorrow')

  await app.close()
})

test('"todo:" without a date word writes the whole line as the task', async () => {
  const { app, win } = await launch(userDataDir())

  await capture(app, win, 'todo: tomorrow is the deadline')

  await openRailSection(win, 'TODO', '.ix-todo')
  const row = win.locator('.ix-todo > .ix-todo__list > .ix-todo-item')
  await expect(row.locator('.ix-todo-item__text')).toHaveText('tomorrow is the deadline')
  await expect(row.locator('.ix-todo-item__due')).toHaveCount(0)

  await app.close()
})

test('"time:" logs a worklog entry against the issue it named', async () => {
  const { app, win } = await launch(userDataDir())

  await capture(app, win, 'time: 1h 30m FID-123 sprint review')
  await expect(win.locator('.ix-toast')).toContainText('1h 30m')

  await openRailSection(win, 'Time Tracking', '.ix-tt')
  // The board only draws Monday to Friday, so a run on a weekend asserts on the week total and
  // the notice instead of a card that has nowhere to be drawn.
  const isWeekday = await win.evaluate(() => {
    const day = new Date().getDay()
    return day >= 1 && day <= 5
  })
  if (isWeekday) {
    const card = win.locator('.ix-tt-card')
    await expect(card).toHaveCount(1)
    await expect(card.locator('.ix-tt-card__key')).toHaveValue('FID-123')
    await expect(card.locator('.ix-tt-card__title')).toHaveValue('sprint review')
    await expect(card.locator('.ix-tt-card__dur')).toHaveValue('1h 30m')
  } else {
    await expect(win.locator('.ix-toast')).toContainText('weekday board')
  }

  await app.close()
})

test('"time:" with no duration refuses to log anything', async () => {
  const { app, win } = await launch(userDataDir())

  await invokeMenu(app, 'palette.open')
  await win.locator('.ix-palette__input').fill('time: sprint review')
  await expect(win.locator('.ix-palette__capture-hint')).toBeVisible()
  await win.keyboard.press('Enter')
  await expect(win.locator('.ix-palette')).toBeVisible()
  await win.keyboard.press('Escape')

  await openRailSection(win, 'Time Tracking', '.ix-tt')
  await expect(win.locator('.ix-tt-card')).toHaveCount(0)

  await app.close()
})

test('"1:1:" starts a preparation run for the person named', async () => {
  const { app, win } = await launch(userDataDir())

  await capture(app, win, '1:1: Tereza N.')
  await expect(win.locator('.ix-toast')).toContainText('Preparing a 1:1 briefing for Tereza N.')

  await openRailSection(win, '1:1', '.ix-oto')
  const card = win.locator('.ix-oto-run')
  await expect(card).toHaveCount(1)
  await expect(card.locator('.ix-oto-run__type')).toHaveText(/preparation/i)
  await expect(card).toContainText('Tereza N.')

  await app.close()
})
