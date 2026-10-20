import { expect, launch, openRailSection, test, unconfiguredAdo, userDataDir } from './harness'

/**
 * The save confirmation exists to show the proposed change before it is written, possibly to the
 * global Claude Code config. Its diff is wider than an ordinary dialog, so the dialog has to make
 * room for it: a diff clipped behind a scrollbar would let a user confirm a write they never saw.
 */
test('the save confirmation shows its whole diff and its buttons, in a small window and a large one', async () => {
  // An empty home, so the global scope is a throwaway ~/.claude and nothing real is read.
  const { app, win } = await launch(userDataDir(), { env: unconfiguredAdo() })

  await openRailSection(win, 'Settings', '.ix-settings')
  await win.locator('.ix-settings__nav-btn', { hasText: 'Agent Tooling' }).click()
  await win.getByRole('tab', { name: 'Permissions' }).click()
  await win.getByLabel('Add allow rule').fill('Bash(git status)')
  await win.getByLabel('Add allow rule').press('Enter')

  const dialog = win.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Confirm change to GLOBAL config' })).toBeVisible()
  await expect(dialog.locator('.ix-at-diff__host .monaco-diff-editor')).toBeVisible()

  // The smallest window the app allows, then a roomy one.
  for (const [width, height] of [
    [940, 600],
    [1280, 820]
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
      [width, height]
    )
    await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(width)

    const layout = await dialog.evaluate((panel) => {
      const body = panel.querySelector('.ix-dialog__body')!
      const confirm = panel.querySelector('.ix-at-confirm')!
      const box = (el: Element): DOMRect => el.getBoundingClientRect()
      const action = [...panel.querySelectorAll('.ix-dialog__actions button')].pop()!
      return {
        viewportHeight: window.innerHeight,
        panel: box(panel).toJSON() as DOMRect,
        content: box(confirm).toJSON() as DOMRect,
        action: box(action).toJSON() as DOMRect,
        clipped: body.scrollWidth - body.clientWidth
      }
    })

    // Nothing of the diff hides behind a horizontal scrollbar, and it sits inside the panel.
    expect(layout.clipped, `${width}x${height}`).toBeLessThanOrEqual(0)
    expect(layout.content.left).toBeGreaterThanOrEqual(layout.panel.left)
    expect(layout.content.right).toBeLessThanOrEqual(layout.panel.right)
    // The panel fits the window, so the title and the confirm button are both reachable.
    expect(layout.panel.top).toBeGreaterThanOrEqual(0)
    expect(layout.panel.bottom).toBeLessThanOrEqual(layout.viewportHeight)
    expect(layout.action.bottom).toBeLessThanOrEqual(layout.viewportHeight)
  }

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
})
