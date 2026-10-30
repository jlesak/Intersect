import { type ElectronApplication, type Page } from '@playwright/test'
import {
  addWorkspace,
  expect,
  invokeMenu,
  launch,
  openRailSection,
  tempDir,
  test,
  userDataDir
} from './harness'

/**
 * Closing the command palette without running a command gives focus back to where it was. The
 * owner is usually in a terminal when they press Cmd+K, so every case starts with a real shell
 * focused and ends by typing into it: a focus check alone would pass for an element that looks
 * focused but is not the one that receives keys.
 */
async function focusedTerminal(app: ElectronApplication, win: Page): Promise<void> {
  await addWorkspace(win, app, tempDir('palettefocusws-'))
  await win.locator('.ix-iconbtn[title="New terminal"]').click()
  await win.locator('.ix-preset', { hasText: 'Shell' }).click()
  const term = win.locator('.xterm')
  await term.waitFor()
  await term.click()
  await expect(win.locator('.xterm-helper-textarea')).toBeFocused()
}

/** Type a marker and wait for the shell to echo it, which only happens if the keys reached it. */
async function typeReachesTerminal(win: Page, marker: string): Promise<void> {
  await win.keyboard.type(marker)
  await expect(win.locator('.xterm-rows')).toContainText(marker)
}

const captures: [string, string][] = [
  ['note:', 'note: x'],
  ['todo:', 'todo: x'],
  ['time:', 'time: 1h FID-1 x'],
  ['1:1:', '1:1: Tereza N.']
]

for (const [prefix, line] of captures) {
  test(`a "${prefix}" capture returns focus to the terminal`, async () => {
    const { app, win } = await launch(userDataDir(), { openOther: true })
    await focusedTerminal(app, win)

    await invokeMenu(app, 'palette.open')
    await win.locator('.ix-palette__input').fill(line)
    await win.keyboard.press('Enter')
    await expect(win.locator('.ix-palette')).toHaveCount(0)

    await expect(win.locator('.xterm-helper-textarea')).toBeFocused()
    await typeReachesTerminal(win, `echo CAP${prefix.length}`)
  })
}

test('Escape returns focus to the terminal', async () => {
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await focusedTerminal(app, win)

  await invokeMenu(app, 'palette.open')
  await expect(win.locator('.ix-palette__input')).toBeFocused()
  await win.keyboard.press('Escape')
  await expect(win.locator('.ix-palette')).toHaveCount(0)

  await expect(win.locator('.xterm-helper-textarea')).toBeFocused()
  await typeReachesTerminal(win, 'echo ESC1')
})

test('a click outside the palette returns focus to the terminal', async () => {
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await focusedTerminal(app, win)

  await invokeMenu(app, 'palette.open')
  await expect(win.locator('.ix-palette__input')).toBeFocused()
  // The overlay covers the window; its top-left corner is outside the dialog.
  await win.locator('.ix-palette-overlay').click({ position: { x: 4, y: 4 } })
  await expect(win.locator('.ix-palette')).toHaveCount(0)

  await expect(win.locator('.xterm-helper-textarea')).toBeFocused()
  await typeReachesTerminal(win, 'echo CLK1')
})

test('a capture returns focus to the Notes capture box', async () => {
  const { app, win } = await launch(userDataDir())
  await openRailSection(win, 'Notes', '.ix-notes')
  const box = win.getByLabel('New note')
  await box.click()
  await expect(box).toBeFocused()

  await invokeMenu(app, 'palette.open')
  await win.locator('.ix-palette__input').fill('note: from the palette')
  await win.keyboard.press('Enter')
  await expect(win.locator('.ix-palette')).toHaveCount(0)
  await expect(win.locator('.ix-notes__today .ix-note__body')).toHaveText('from the palette')

  await expect(box).toBeFocused()
  await win.keyboard.type('still typing')
  await expect(box).toHaveValue('still typing')
})

test('a command that opens a view still decides focus itself', async () => {
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await focusedTerminal(app, win)

  // The first terminal is still mounted and focusable when the palette closes, so a restore that
  // ignored the command would hand the keys back to it instead of the new tab's terminal.
  await invokeMenu(app, 'palette.open')
  await win.locator('.ix-palette__input').fill('new shell')
  await win.keyboard.press('Enter')
  await expect(win.locator('.ix-palette')).toHaveCount(0)
  await expect(win.locator('.ix-tab')).toHaveCount(2)

  // The active tab is the new one, and its terminal is the focused one.
  await expect(win.locator('.ix-tab--active')).toHaveCount(1)
  await expect(win.locator('.xterm-helper-textarea:focus')).toHaveCount(1)
  await typeReachesTerminal(win, 'echo NEW1')
})
