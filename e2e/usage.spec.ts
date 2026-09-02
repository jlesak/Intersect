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
