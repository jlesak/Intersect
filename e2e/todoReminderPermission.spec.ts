import type { ElectronApplication, Locator, Page } from '@playwright/test'
import type { IpcApi, TodoReminderPermission } from '../src/common/ipc'
import { expect, launch, openRailSection, test, unconfiguredAdo, userDataDir } from './harness'

interface ReminderHook {
  setReminderPermission(permission: TodoReminderPermission): void
  reminderSettingsRequests: string[]
}

async function setPermission(app: ElectronApplication, permission: TodoReminderPermission): Promise<void> {
  await app.evaluate((_electron, status) => {
    const hook = (globalThis as unknown as { __intersectE2e: ReminderHook }).__intersectE2e
    hook.setReminderPermission(status)
  }, permission)
}

// Simulate the renderer's focus event from main without bringing the hidden test window forward.
async function returnToWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }) => {
    await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
      "window.dispatchEvent(new Event('focus'))"
    )
  })
}

async function pinSize(app: ElectronApplication, win: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => win.evaluate(() => ({ width: innerWidth, height: innerHeight })))
    .toEqual({ width, height: height - 32 })
}

async function withinViewport(control: Locator): Promise<void> {
  await expect(control).toBeVisible()
  expect(await control.evaluate((el) => {
    const box = el.getBoundingClientRect()
    return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
  })).toBe(true)
}

async function addTimedTask(win: Page): Promise<void> {
  await win.getByTitle('Add due date', { exact: true }).click()
  await win.locator('.ix-todo__add input[type=date]').fill('2020-01-01')
  await win.getByLabel('New task due time').fill('12:30')
  await win.getByPlaceholder('Add a task… (Enter)').fill('Permission test task')
  await win.getByPlaceholder('Add a task… (Enter)').press('Enter')
  await expect(win.locator('.ix-todo-item__text')).toHaveText('Permission test task')
}

for (const [width, height] of [[940, 600], [1280, 820]]) {
  test(`denial warning, settings handoff and task lifecycle at ${width}x${height}`, async () => {
    const { app, win, errors } = await launch(userDataDir(), { env: unconfiguredAdo() })
    await pinSize(app, win, width, height)
    await setPermission(app, 'denied')
    await openRailSection(win, 'TODO', '.ix-todo')
    const warning = win.locator('.ix-todo__reminder-warning')
    await expect(warning).toHaveCount(0)
    await addTimedTask(win)
    await expect(warning).toBeVisible()
    const settings = win.getByRole('button', { name: 'Open notification settings' })
    const dismiss = win.getByRole('button', { name: 'Dismiss', exact: true })
    await withinViewport(settings)
    await withinViewport(dismiss)
    await withinViewport(win.getByPlaceholder('Add a task… (Enter)'))
    await settings.focus()
    await settings.press('Enter')
    await expect.poll(() => app.evaluate(() =>
      (globalThis as unknown as { __intersectE2e: ReminderHook }).__intersectE2e.reminderSettingsRequests
    )).toEqual(['x-apple.systempreferences:com.apple.preference.notifications'])
    await expect(warning).toBeVisible()
    await setPermission(app, 'authorized')
    await returnToWindow(app)
    await expect(warning).toHaveCount(0)
    await setPermission(app, 'denied')
    await returnToWindow(app)
    await expect(warning).toBeVisible()
    await dismiss.focus()
    await dismiss.press('Space')
    await expect(warning).toHaveCount(0)
    await win.locator('.ix-todo-nav__item', { hasText: 'Today' }).click()
    await win.locator('.ix-todo-nav__item', { hasText: 'Inbox' }).click()
    await expect(warning).toHaveCount(0)
    await setPermission(app, 'provisional')
    await returnToWindow(app)
    await expect.poll(() => win.evaluate(() => (window as unknown as { intersect: IpcApi }).intersect.todo.getReminderPermission()))
      .toBe('provisional')
    await setPermission(app, 'denied')
    await returnToWindow(app)
    await expect(warning).toBeVisible()

    await win.getByTitle('Edit', { exact: true }).click()
    await win.getByPlaceholder('Task', { exact: true }).fill('Edited under denial')
    const save = win.getByRole('button', { name: 'Save', exact: true })
    await save.scrollIntoViewIfNeeded()
    await withinViewport(save)
    await save.click()
    await expect(win.locator('.ix-todo-item__text')).toHaveText('Edited under denial')
    await win.getByTitle('Mark as done', { exact: true }).click()
    await expect(warning).toHaveCount(0)
    await win.getByRole('button', { name: 'Show done (1)', exact: true }).click()
    await win.getByTitle('Mark as not done', { exact: true }).click()
    await expect(warning).toBeVisible()
    await win.getByTitle('Delete', { exact: true }).click()
    await expect(win.locator('.ix-todo-item')).toHaveCount(0)
    await expect(warning).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

for (const permission of ['error', 'unavailable'] as const) {
  test(`tasks can be created and edited when permission is ${permission}`, async () => {
    const { app, win, errors } = await launch(userDataDir(), { env: unconfiguredAdo() })
    await pinSize(app, win, 940, 600)
    await setPermission(app, permission)
    await openRailSection(win, 'TODO', '.ix-todo')
    await addTimedTask(win)
    await expect(win.locator('.ix-todo__reminder-warning')).toHaveCount(0)
    expect(await win.evaluate(() => (window as unknown as { intersect: IpcApi }).intersect.todo.getReminderPermission())).toBe(permission)
    await win.getByTitle('Edit', { exact: true }).click()
    await win.getByPlaceholder('Task', { exact: true }).fill('Edited with unavailable reminders')
    const save = win.getByRole('button', { name: 'Save', exact: true })
    await withinViewport(save)
    await save.click()
    await expect(win.locator('.ix-todo-item__text')).toHaveText('Edited with unavailable reminders')
    expect(errors).toEqual([])
  })
}

test('dismissal survives leaving TODO but a restart of the same profile shows denial again', async () => {
  const profile = userDataDir()
  const first = await launch(profile, { env: unconfiguredAdo() })
  await pinSize(first.app, first.win, 940, 600)
  await setPermission(first.app, 'denied')
  await openRailSection(first.win, 'TODO', '.ix-todo')
  await addTimedTask(first.win)
  await first.win.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await openRailSection(first.win, 'Notes', '.ix-notes')
  await openRailSection(first.win, 'TODO', '.ix-todo')
  await returnToWindow(first.app)
  await expect(first.win.locator('.ix-todo__reminder-warning')).toHaveCount(0)
  expect(first.errors).toEqual([])
  await first.app.close()
  const second = await launch(profile, { env: unconfiguredAdo() })
  await pinSize(second.app, second.win, 940, 600)
  await setPermission(second.app, 'denied')
  await openRailSection(second.win, 'TODO', '.ix-todo')
  await returnToWindow(second.app)
  await expect(second.win.locator('.ix-todo__reminder-warning')).toBeVisible()
  expect(second.errors).toEqual([])
})
