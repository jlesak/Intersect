import { addWorkspace, expect, launch, tempDir, test, userDataDir } from './harness'

/**
 * Find-in-scrollback, end to end. Every link of the chain is covered on its own by component
 * tests; what only a running app can show is that they are actually joined - the terminal area
 * binds the key, the key resolves to the pane the user is looking at, and the pane renders the
 * bar. The search itself is not driven here: that would need a real shell's output on screen,
 * which is slow and timing-dependent for what it would add.
 */
test('Cmd+F opens the find bar on the focused terminal, and Escape gives the shell back', async () => {
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await addWorkspace(win, app, tempDir('findws-'))

  await win.locator('.ix-iconbtn[title="New terminal"]').click()
  await win.locator('.ix-preset', { hasText: 'Shell' }).click()
  const term = win.locator('.xterm')
  await term.waitFor()
  await term.click()

  await win.keyboard.press('Meta+f')
  await expect(win.locator('.ix-find__input')).toBeFocused()

  await win.keyboard.press('Escape')
  await expect(win.locator('.ix-find')).toHaveCount(0)
  await expect(win.locator('.ix-pane__host .xterm-helper-textarea')).toBeFocused()
})
