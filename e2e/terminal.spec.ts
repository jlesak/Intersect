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

/**
 * Per-pane tab groups, end to end. The pieces are covered individually by component tests; what
 * only a running app can show is that a split really does put each terminal's name in a bar of
 * its own directly above that terminal, and that collapsing the split brings every tab back into
 * one bar rather than stranding any of them.
 */
test('a split gives each pane its own tab bar above its terminal, and collapsing merges them', async () => {
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await addWorkspace(win, app, tempDir('groupws-'))

  const openShell = async (bar: number): Promise<void> => {
    await win.locator('.ix-tabbar').nth(bar).locator('.ix-iconbtn[title="New terminal"]').click()
    await win.locator('.ix-preset', { hasText: 'Shell' }).click()
  }

  await openShell(0)
  await win.locator('.xterm').first().waitFor()
  await expect(win.locator('.ix-tabbar')).toHaveCount(1)

  // Splitting leaves the first tab where it was and opens a second, empty group beside it.
  await win.locator('.ix-layout[aria-label="Two columns"]').click()
  await expect(win.locator('.ix-tabbar')).toHaveCount(2)
  await expect(win.locator('.ix-pane').nth(0).locator('.ix-tab')).toHaveCount(1)
  await expect(win.locator('.ix-pane').nth(1).locator('.ix-tab')).toHaveCount(0)
  await expect(win.locator('.ix-pane').nth(1).locator('.ix-pane__empty')).toBeVisible()

  await openShell(1)
  await expect(win.locator('.ix-pane').nth(1).locator('.ix-tab')).toHaveCount(1)

  // The point of the whole change: the tab named in a pane's bar is the very terminal running in
  // that pane's body, which the session id on the host spells out.
  const named: string[] = []
  for (const pane of [0, 1]) {
    const scope = win.locator('.ix-pane').nth(pane)
    await expect(scope.locator('.ix-tabbar .ix-tab')).toHaveCount(1)
    await expect(scope.locator('.ix-pane__body .xterm')).toBeVisible()
    const tabId = await scope.locator('.ix-tab').getAttribute('data-tab-id')
    const sessionId = await scope.locator('.ix-pane__host').getAttribute('data-session-id')
    expect(tabId).toBeTruthy()
    expect(sessionId?.endsWith(`:${tabId}`)).toBe(true)
    named.push(tabId as string)
  }
  expect(named[0]).not.toBe(named[1])

  // The workspace tools ride in the top-right group's bar, so there is exactly one of each.
  await expect(win.locator('.ix-layouts')).toHaveCount(1)
  await expect(win.locator('.ix-tabbar').nth(1).locator('.ix-layouts')).toHaveCount(1)

  // Working in a pane is how focus moves between groups, and the bars say which group has it.
  await win.locator('.ix-pane').nth(0).locator('.xterm').click()
  await expect(win.locator('.ix-tabbar').nth(0)).toHaveClass(/ix-tabbar--focused/)
  await expect(win.locator('.ix-tabbar').nth(1)).toHaveClass(/ix-tabbar--unfocused/)
  await win.locator('.ix-pane').nth(1).locator('.xterm').click()
  await expect(win.locator('.ix-tabbar').nth(1)).toHaveClass(/ix-tabbar--focused/)
  await expect(win.locator('.ix-tabbar').nth(0)).toHaveClass(/ix-tabbar--unfocused/)

  // Collapsing merges both groups into one bar, keeping both tabs reachable.
  await win.locator('.ix-layout[aria-label="Single pane"]').click()
  await expect(win.locator('.ix-tabbar')).toHaveCount(1)
  await expect(win.locator('.ix-tab')).toHaveCount(2)
  for (const tabId of named) {
    await expect(win.locator(`.ix-tab[data-tab-id="${tabId}"]`)).toHaveCount(1)
  }
})

/**
 * The tab drag, end to end. jsdom implements neither DataTransfer nor DragEvent, so every
 * component test of the drag drives hand-built stand-ins over hand-fed coordinates. What only a
 * running browser can show is that the drag starts at all, that the private transfer type
 * survives the round trip, and that a release really does land the tab in the pane it was aimed
 * at - including on the pane body, which is the whole target an empty pane offers.
 */
test('a tab is dragged onto another pane, and back onto the body of the one it left', async () => {
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await addWorkspace(win, app, tempDir('dragws-'))

  const pane = (n: number) => win.locator('.ix-pane').nth(n)
  const openShell = async (bar: number): Promise<void> => {
    await win.locator('.ix-tabbar').nth(bar).locator('.ix-iconbtn[title="New terminal"]').click()
    await win.locator('.ix-preset', { hasText: 'Shell' }).click()
  }

  await openShell(0)
  await win.locator('.xterm').first().waitFor()
  await win.locator('.ix-layout[aria-label="Two columns"]').click()
  await openShell(1)
  await expect(pane(1).locator('.xterm')).toBeVisible()

  const moved = await pane(0).locator('.ix-tab').getAttribute('data-tab-id')
  const shows = (n: number, tabId: string | null): Promise<void> =>
    expect(pane(n).locator('.ix-pane__host')).toHaveAttribute(
      'data-session-id',
      new RegExp(`:${tabId}$`)
    )

  // Onto the other pane's strip: the tab leaves its own bar, joins that one, and is what the
  // pane now runs rather than the terminal it was showing a moment ago.
  await pane(0).locator('.ix-tab').dragTo(pane(1).locator('.ix-tabs'))
  await expect(pane(1).locator('.ix-tab')).toHaveCount(2)
  await expect(pane(0).locator('.ix-tab')).toHaveCount(0)
  await expect(pane(0).locator('.ix-pane__empty')).toBeVisible()
  await shows(1, moved)

  // And back, onto the empty pane's body rather than its 32px strip.
  await pane(1).locator(`.ix-tab[data-tab-id="${moved}"]`).dragTo(pane(0).locator('.ix-pane__body'))
  await expect(pane(0).locator(`.ix-tab[data-tab-id="${moved}"]`)).toHaveCount(1)
  await expect(pane(1).locator('.ix-tab')).toHaveCount(1)
  await shows(0, moved)
})
