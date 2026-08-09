import { hasExited, type AppProcess } from '../tooling/e2eApps'
import { expect, launch, test, userDataDir } from './harness'

/**
 * The one guarantee the harness makes about a test it has already lost: the app is still taken
 * away. It is proved by actually losing one, because the abandonment path cannot be reached any
 * other way - every other spec in the suite passes, and a passing test proves nothing about what
 * happens to an app when an assertion does not hold.
 *
 * `test.fail()` is what makes a deliberate failure liveable in a suite that is a merge gate: the
 * test below must fail, and the run is green because it did. It also means the proof cannot rot
 * quietly - if someone later makes that assertion hold, the run goes red for passing.
 */

/**
 * The operating-system process of the app the failing test leaves behind, read by the test after
 * it. Sharing state between tests is exactly what makes this pair a proof: the second test can only
 * see the first test's app from outside the first test, which is where the teardown under
 * examination runs.
 *
 * The process is stashed rather than the app because a closed app will no longer answer for it,
 * while the process goes on reporting how it ended for as long as anything holds it.
 */
let abandoned: AppProcess | undefined

test('an app outlives the test that failed while driving it', async () => {
  test.fail()
  const { app } = await launch(userDataDir())
  abandoned = app.process()

  // Nothing closes the app on this path, which is the whole point: this is every spec in the suite
  // as it behaves the day one of its assertions stops holding.
  expect(true, 'this assertion fails on purpose - see the test that follows').toBe(false)
})

test('the app the failed test abandoned has been closed', () => {
  expect(abandoned, 'the test before this one never got as far as launching').toBeDefined()
  expect(hasExited(abandoned!), 'the abandoned app is still running').toBe(true)
})
