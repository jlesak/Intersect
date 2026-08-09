import { type Page } from '@playwright/test'
import {
  addWorkspace,
  expect,
  launch,
  stubQuitConfirm,
  tempDir,
  test,
  userDataDir
} from './harness'

async function openShellTab(win: Page): Promise<void> {
  await win.locator('.ix-iconbtn[title="New terminal"]').click()
  await win.locator('.ix-preset', { hasText: 'Shell' }).click()
}

/**
 * A background terminal that prints Intersect's OSC 9 idle marker must turn its tab 'done' (green)
 * and pulse. The marker is emitted from a session that is NOT the active one, so the alert is not
 * suppressed as "already viewed". Clicking the tab acknowledges it and clears the status.
 */
test('a background session that signals idle turns its tab done, and viewing it clears the status', async () => {
  const profileDir = userDataDir()
  const wsDir = tempDir('attn-')
  const { app, win } = await launch(profileDir, { openOther: true })
  await addWorkspace(win, app, wsDir)

  // Tab A: schedule the idle marker to print shortly, in the background, then hand focus away.
  await openShellTab(win)
  await expect(win.locator('.ix-tab')).toHaveCount(1)
  const term = win.locator('.xterm')
  await term.waitFor()
  await term.click()
  // printf turns \033/\007 into the real ESC/BEL; backgrounded so we can switch tabs immediately.
  await win.keyboard.type("(sleep 1 && printf '\\033]9;INTERSECT_IDLE\\007') &\n")

  // Tab B becomes the active session, so A is now a background session.
  await openShellTab(win)
  await expect(win.locator('.ix-tab')).toHaveCount(2)

  // The background tab A turns done once its scheduled marker lands.
  await expect(win.locator('.ix-tab--done')).toHaveCount(1, { timeout: 8000 })

  // Opening (activating) the tab acknowledges it and clears the status.
  await win.locator('.ix-tab--done').click()
  await expect(win.locator('.ix-tab--done')).toHaveCount(0)
})

/**
 * Submitting a prompt into a Claude Code tab (Enter) must mark it 'working' (blue), independent of
 * whether the `claude` binary is actually installed on this machine - the detection is driven by
 * the user's keystroke into a claude-preset session, not by anything Claude itself outputs.
 */
test('submitting a prompt in a Claude tab marks it working', async () => {
  const profileDir = userDataDir()
  const wsDir = tempDir('attn-working-')
  const { app, win } = await launch(profileDir, { openOther: true })
  await addWorkspace(win, app, wsDir)

  // The prompt leaves the session live, so quitting will ask to suspend it.
  await stubQuitConfirm(app)
  await win.locator('.ix-iconbtn[title="New terminal"]').click()
  await win.locator('.ix-preset', { hasText: 'Claude Code' }).click()
  await expect(win.locator('.ix-tab')).toHaveCount(1)

  const term = win.locator('.xterm')
  await term.waitFor()
  await term.click()
  await win.keyboard.type('hello\n')

  await expect(win.locator('.ix-tab--working')).toHaveCount(1)
})
