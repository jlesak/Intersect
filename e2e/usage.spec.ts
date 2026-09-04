import { expect, launch, test, userDataDir } from './harness'

/**
 * The live-usage consent gate, driven through the real app.
 *
 * Deliberately never clicks Allow. A yes makes the core read Claude Code's real OAuth credentials,
 * which on a developer's Mac raises the Keychain dialog for real and would hang the run waiting for
 * a human. The consequence of a yes is covered by the unit tests, which fake the credential read.
 * What only the real app can show is the half that must not touch anything: that a fresh profile
 * asks first, that a no is respected, and that neither answer has to be given twice.
 */

const PROMPT = '.ix-usage__consent'
const REFRESH = '.ix-usage__refresh'
const ENABLE = '.ix-usage__enable'

test('a fresh profile is asked before any credential is read', async () => {
  const { win } = await launch(userDataDir())

  const prompt = win.locator(PROMPT)
  await expect(prompt).toBeVisible()
  // The two things that make the OS dialog expected rather than alarming.
  await expect(prompt).toContainText('sign-in token')
  await expect(prompt).toContainText('Keychain')

  // No refresh button yet: there is nothing to refresh with until the question is answered, and a
  // button that reads credentials must not be reachable before the user has allowed that.
  await expect(win.locator(REFRESH)).toHaveCount(0)
})

test('the panel still shows its own state while the question is open', async () => {
  const { win } = await launch(userDataDir())

  await expect(win.locator(PROMPT)).toBeVisible()
  // A fresh profile has no statusline capture, so the panel's usual empty hint stands underneath
  // the question rather than being replaced by it.
  await expect(win.locator('.ix-usage__empty')).toBeVisible()
})

test('a no closes the question, leaves a way back, and is not asked again after a relaunch', async () => {
  const profileDir = userDataDir()

  const first = await launch(profileDir)
  await first.win.locator(PROMPT).getByText('Not now').click()

  await expect(first.win.locator(PROMPT)).toHaveCount(0)
  // Declining hides the feature, not the offer: one quiet control is left to turn it on later.
  await expect(first.win.locator(ENABLE)).toBeVisible()
  await expect(first.win.locator(REFRESH)).toHaveCount(0)

  await first.app.close()

  const second = await launch(profileDir)
  await expect(second.win.locator('.ix-usage')).toBeVisible()
  await expect(second.win.locator(PROMPT)).toHaveCount(0)
  await expect(second.win.locator(ENABLE)).toBeVisible()
  expect(second.errors).toEqual([])
})

/**
 * The usage panel does not shrink, and the consent question makes it taller still. In a window
 * short enough, the sidebar's middle slot was squeezed below the height of the Add button it has
 * to show, the button painted outside that slot, and this panel - painting later - covered it and
 * swallowed every click on it. Playwright reported that as `.ix-usage intercepts pointer events`
 * on thirty unrelated specs, none of which mention usage.
 *
 * The heights below bracket the failure: 700px broke it before the fix, and each step down puts
 * more of the sidebar's fixed furniture in competition for the same space.
 */
for (const height of [700, 620, 560]) {
  test(`the usage panel never covers the sidebar's controls at ${height}px`, async () => {
    const { app, win } = await launch(userDataDir())
    await app.evaluate(({ BrowserWindow }, h) => {
      BrowserWindow.getAllWindows()[0].setSize(1280, h as number)
    }, height)
    await win.locator('.ix-rail__btn--other').click()

    // Asserted through the browser's own hit testing rather than by comparing rectangles: what
    // matters is which element receives a press at the button's centre, and nothing else.
    const topmost = await win.evaluate(() => {
      const add = document.querySelector('.ix-add') as HTMLElement
      add.scrollIntoView({ block: 'center' })
      const r = add.getBoundingClientRect()
      return (document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) as HTMLElement)
        ?.className
    })
    expect(topmost).toBe('ix-add')

    // And the click itself, which is what the thirty specs were actually doing.
    await win.locator('.ix-add').click({ timeout: 5000 })
  })
}
