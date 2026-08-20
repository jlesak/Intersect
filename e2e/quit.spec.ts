import { hasExited } from '../tooling/e2eApps'
import {
  addWorkspace,
  expect,
  launch,
  signalSystemShutdown,
  stubQuitConfirm,
  stubQuitConfirmCancel,
  tempDir,
  test,
  userDataDir
} from './harness'

/**
 * The two halves of the quit guard, proved against each other.
 *
 * A live Claude session puts a confirmation in front of every quit, and the confirmation waits for
 * an answer with no deadline. That is right while somebody is there and ruinous while nobody is: a
 * logout, restart or shut down sends the app the same quit request, and an app that sits on an
 * unanswered dialog halts the whole logout with no window on screen to explain why.
 *
 * Both tests answer the confirmation with Cancel, which is what makes them mean anything. Under a
 * Cancel-answering stub an app that exits can only have exited without asking, and an app that is
 * asked stays alive - so the first test's clean exit and the second test's survival are each proof
 * the other path was taken.
 */

/** Open a Claude Code tab in the active workspace, which is what makes a quit ask. */
async function openClaudeTab(win: Awaited<ReturnType<typeof launch>>['win']): Promise<void> {
  await win.locator('.ix-iconbtn[title="New terminal"]').click()
  await win.locator('.ix-preset', { hasText: 'Claude Code' }).click()
  await expect(win.locator('.ix-tab')).toHaveCount(1)
  await expect(win.locator('.xterm')).toBeVisible()
}

test('a system shutdown finishes the quit by itself, without asking to suspend', async () => {
  const wsDir = tempDir('shutdownws-')
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await addWorkspace(win, app, wsDir)
  await stubQuitConfirmCancel(app)
  await openClaudeTab(win)

  // The real notification, then the quit the system sends after it - the order a logout produces.
  const proc = app.process()
  await signalSystemShutdown(app)
  await app.evaluate(({ app: electronApp }) => electronApp.quit())

  await expect
    .poll(() => hasExited(proc), {
      message: 'the app never finished a quit that nobody was there to answer'
    })
    .toBe(true)
  expect(proc.exitCode, 'the app did not exit through its own coordinated shutdown').toBe(0)
})

test('an ordinary quit still waits for the answer, and Cancel keeps everything running', async () => {
  const wsDir = tempDir('cancelws-')
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await addWorkspace(win, app, wsDir)
  const promptCount = await stubQuitConfirmCancel(app)
  await openClaudeTab(win)

  const proc = app.process()
  await app.evaluate(({ app: electronApp }) => electronApp.quit())

  // Waiting for the confirmation to have been raised is what makes the survival below a statement
  // about Cancel rather than about a quit that had not got started yet.
  await expect
    .poll(promptCount, { message: 'the quit never raised the suspend confirmation' })
    .toBe(1)
  expect(hasExited(proc), 'Cancel tore the app down anyway').toBe(false)
  await expect(win.locator('.ix-tab')).toHaveCount(1)

  // And the app is still quittable: the cancelled quit left nothing latched.
  await stubQuitConfirm(app)
  await app.close()
  expect(hasExited(proc), 'the app would not quit after a cancelled one').toBe(true)
})
