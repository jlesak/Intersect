import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import {
  addWorkspace,
  expect,
  launch,
  stubQuitConfirm,
  tempDir,
  test,
  userDataDir
} from './harness'

test('creates a workspace via the folder picker with the basename as its name', async () => {
  const profileDir = userDataDir()
  const wsDir = tempDir('myproject-')
  const { app, win } = await launch(profileDir, { openOther: true })
  await addWorkspace(win, app, wsDir)
  await expect(win.locator('.ix-ws--active .ix-ws__name')).toHaveText(basename(wsDir))
})

test('opens a Shell terminal and streams command output', async () => {
  const profileDir = userDataDir()
  const wsDir = tempDir('shellws-')
  const { app, win } = await launch(profileDir, { openOther: true })
  await addWorkspace(win, app, wsDir)

  // Open Shell preset.
  await win.locator('.ix-iconbtn[title="New terminal"]').click()
  await win.locator('.ix-preset', { hasText: 'Shell' }).click()
  await expect(win.locator('.ix-tab')).toHaveCount(1)

  // Terminal renders; type a command and see its output.
  const term = win.locator('.xterm')
  await term.waitFor()
  await term.click()
  await win.keyboard.type('echo INTERSECT_E2E_OK\n')
  await expect(win.locator('.xterm-rows')).toContainText('INTERSECT_E2E_OK', { timeout: 20_000 })
})

test('opens a Claude Code tab rooted in the workspace', async () => {
  const profileDir = userDataDir()
  const wsDir = tempDir('claudews-')
  const { app, win } = await launch(profileDir, { openOther: true })
  await addWorkspace(win, app, wsDir)

  // This tab stays live to the end, so quitting will ask to suspend it.
  await stubQuitConfirm(app)
  await win.locator('.ix-iconbtn[title="New terminal"]').click()
  await win.locator('.ix-preset', { hasText: 'Claude Code' }).click()
  // The tab + its terminal exist regardless of whether `claude` is installed on this machine.
  await expect(win.locator('.ix-tab')).toHaveCount(1)
  await expect(win.locator('.ix-tab__preset')).toHaveText('AI')
  await expect(win.locator('.xterm')).toBeVisible()

  // Closed here rather than left to the harness, because with a live session this close is the only
  // thing in the suite that walks the real quit: the confirmation, the suspend, the shutdown. The
  // harness would kill an app that never got through it, and a quit that stopped working would go
  // unnoticed.
  await app.close()
})

test('splits into two columns and places both terminals', async () => {
  const profileDir = userDataDir()
  const wsDir = tempDir('splitws-')
  const { app, win } = await launch(profileDir, { openOther: true })
  await addWorkspace(win, app, wsDir)

  const open = async (): Promise<void> => {
    await win.locator('.ix-iconbtn[title="New terminal"]').click()
    await win.locator('.ix-preset', { hasText: 'Shell' }).click()
  }
  await open()
  await open()
  await expect(win.locator('.ix-tab')).toHaveCount(2)

  await win.locator('.ix-layout[title="Two columns"]').click()
  await expect(win.locator('.ix-stage--columns')).toBeVisible()
  await expect(win.locator('.ix-pane')).toHaveCount(2)

  // Fill the empty pane with the other tab, then both panes host a terminal.
  await win.locator('.ix-pane--empty .ix-btn').first().click()
  await expect(win.locator('.ix-pane .xterm')).toHaveCount(2)
})

test('deletes a workspace after confirming, leaving the folder on disk untouched', async () => {
  const profileDir = userDataDir()
  const wsDir = tempDir('delws-')
  const { app, win } = await launch(profileDir, { openOther: true })
  await addWorkspace(win, app, wsDir)
  await expect(win.locator('.ix-ws')).toHaveCount(1)

  await win.locator('.ix-ws').first().click({ button: 'right' })
  await win.locator('.ix-menu__item--danger', { hasText: 'Delete workspace' }).click()
  await win.locator('.ix-dialog').waitFor()
  await win.locator('.ix-dialog .ix-btn--danger').click()

  await expect(win.locator('.ix-ws')).toHaveCount(0)
  expect(existsSync(wsDir), 'workspace folder must not be deleted from disk').toBe(true)
})

test('restores the selected workspace, its tabs and layout after restart', async () => {
  const profileDir = userDataDir()
  const wsDir = tempDir('persistws-')

  const first = await launch(profileDir, { openOther: true })
  await addWorkspace(first.win, first.app, wsDir)
  await first.win.locator('.ix-iconbtn[title="New terminal"]').click()
  await first.win.locator('.ix-preset', { hasText: 'Shell' }).click()
  await expect(first.win.locator('.ix-tab')).toHaveCount(1)
  await first.win.locator('.ix-layout[title="Two columns"]').click()
  await expect(first.win.locator('.ix-stage--columns')).toBeVisible()
  await first.app.close()

  // Relaunch against the same user-data dir.
  const second = await launch(profileDir, { openOther: true })
  await expect(second.win.locator('.ix-ws--active .ix-ws__name')).toHaveText(basename(wsDir))
  await expect(second.win.locator('.ix-tab')).toHaveCount(1)
  await expect(second.win.locator('.ix-stage--columns')).toBeVisible()
})
