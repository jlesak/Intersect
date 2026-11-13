import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, launch, openRailSection, test, userDataDir } from './harness'

/**
 * TODO reminders end to end. An e2e run never touches macOS: main swaps the addon for a recording
 * stand-in that writes what would be pending to `todo-reminders.e2e.json` in the profile. A real
 * notification cannot be clicked from here either, so a warm click goes through main's e2e hook
 * and a cold launch through INTERSECT_E2E_REMINDER_LAUNCH; both enter the same activation module a
 * real click does.
 */

interface RecordedReminder {
  id: string
  title: string
  body: string
  local: { year: number; month: number; day: number; hour: number; minute: number }
}

const pad = (n: number): string => String(n).padStart(2, '0')
function tomorrow(): { key: string; year: number; month: number; day: number } {
  const now = new Date()
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return {
    key: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate()
  }
}

const recorded = (profile: string): RecordedReminder[] => {
  try {
    return JSON.parse(readFileSync(join(profile, 'todo-reminders.e2e.json'), 'utf8'))
  } catch {
    return []
  }
}

const rows = (win: Page) => win.locator('.ix-todo > .ix-todo__list > .ix-todo-item')

/** Create a project, open it, and add a task due tomorrow at 14:30 through the add row. */
async function addTimedTask(win: Page, project: string, text: string): Promise<void> {
  await openRailSection(win, 'TODO', '.ix-todo')
  await win.getByTitle('New TODO project').click()
  await win.getByRole('textbox', { name: 'Project name' }).fill(project)
  await win.getByRole('textbox', { name: 'Project name' }).press('Enter')
  await win.locator('.ix-todo-nav__item', { hasText: project }).click()
  await win.getByTitle('Add due date').click()
  await win.locator('.ix-todo__date').fill(tomorrow().key)
  await win.getByLabel('New task due time').fill('14:30')
  await win.getByPlaceholder('Add a task… (Enter)').fill(text)
  await win.getByPlaceholder('Add a task… (Enter)').press('Enter')
  await expect(rows(win).filter({ hasText: text })).toHaveCount(1)
}

/** The task id of the one reminder the profile has recorded, once there is exactly one. */
async function onlyReminderTaskId(profile: string): Promise<string> {
  await expect.poll(() => recorded(profile).length).toBe(1)
  return recorded(profile)[0].id.replace('todo-reminder:', '')
}

async function expectTaskOpened(win: Page, project: string, text: string): Promise<void> {
  await expect(win.locator('.ix-todo-nav__item--active', { hasText: project })).toBeVisible()
  await expect(rows(win).filter({ hasText: text })).toHaveClass(/ix-todo-item--focused/)
}

test('a timed task records one reminder, and completing it removes the reminder', async () => {
  const profile = userDataDir()
  const { win } = await launch(profile)
  await addTimedTask(win, 'Release', 'Ship the build')

  await expect.poll(() => recorded(profile)).toEqual([
    expect.objectContaining({
      title: 'Ship the build',
      body: 'Due 14:30 · Release',
      local: { year: tomorrow().year, month: tomorrow().month, day: tomorrow().day, hour: 14,
        minute: 30 }
    })
  ])

  await rows(win).filter({ hasText: 'Ship the build' }).locator('.ix-todo-item__check').click()
  await expect.poll(() => recorded(profile)).toEqual([])
})

test('a reminder clicked while no window is open opens a window on its task', async () => {
  const profile = userDataDir()
  const { app, win } = await launch(profile)
  await addTimedTask(win, 'Release', 'Review the notes')
  const taskId = await onlyReminderTaskId(profile)

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
    .toBe(0)

  const opened = app.waitForEvent('window')
  await activateReminder(app, taskId)
  const next = await opened
  await next.waitForSelector('.ix-wordmark__name')
  await expectTaskOpened(next, 'Release', 'Review the notes')
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
})

test('a launch from a reminder opens the app on its task, in one window', async () => {
  const profile = userDataDir()
  const first = await launch(profile)
  await addTimedTask(first.win, 'Release', 'Tag the release')
  const taskId = await onlyReminderTaskId(profile)
  await first.app.close()

  const second = await launch(profile, { env: { INTERSECT_E2E_REMINDER_LAUNCH: taskId } })
  await expectTaskOpened(second.win, 'Release', 'Tag the release')
  expect(second.app.windows()).toHaveLength(1)
  expect(await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
    .toBe(1)
  // The restart rescheduled from the same list and left one reminder, not two.
  expect(recorded(profile).map((r) => r.id)).toEqual([`todo-reminder:${taskId}`])
})

async function activateReminder(app: ElectronApplication, taskId: string): Promise<void> {
  await app.evaluate((_electron, id) => {
    const hook = (globalThis as unknown as {
      __intersectE2e?: { activateReminder(taskId: string): void }
    }).__intersectE2e
    if (!hook) throw new Error('the e2e reminder hook is missing; is INTERSECT_E2E=1 set?')
    hook.activateReminder(id)
  }, taskId)
}
