import { expect, launch, test, userDataDir } from './harness'

// Saturday and Sunday get the weekend line instead of a day total, and the timer's own logging
// notice differs there too - so the assertions about a figure only hold on a weekday.
const RUNS_ON_WEEKDAY = ![0, 6].includes(new Date().getDay())

/**
 * The case every single launch hits: the Dashboard is the landing view, and on a fresh profile no
 * source it reads is configured. It matters more than any populated fixture because a crash here is
 * a crash on boot - the shell's region boundary would replace the whole main area with .ix-crash.
 */
test('a fresh profile lands on the Dashboard with all four zones in their empty states', async () => {
  const { app, win } = await launch(userDataDir())

  await expect(win.locator('.ix-dash')).toBeVisible()
  // Nothing was clicked: the shell fell back to the rail's first section owning a main component.
  await expect(win.locator('.ix-rail__btn--active')).toHaveText('Dashboard')

  await expect(win.locator('.ix-dash-zone__title')).toHaveText([
    'Needs action',
    'Running sessions',
    'Time today',
    'System status'
  ])

  // An empty zone shrinks to a one-line state; it never disappears and never moves.
  await expect(win.locator('.ix-dash-zone')).toHaveCount(4)
  await expect(win.locator('.ix-dash-group__label')).toHaveText(['Pull requests', 'Deadlines'])
  // Whether Azure DevOps counts as connected depends on the credentials of the machine running the
  // suite (`~/.claude.json` or `AZURE_DEVOPS_*`), so the PR line has two legitimate readings here.
  // Both are asserted because the one thing it must never do is stay silent about which is true.
  await expect(win.locator('.ix-dash-group__empty .ix-dash-note__text').first()).toHaveText(
    /No pull request is waiting on you\.|Azure DevOps is not connected/
  )
  await expect(win.locator('.ix-dash-group__empty .ix-dash-note__text').nth(1)).toHaveText(
    'Nothing is due today.'
  )
  await expect(win.locator('.ix-dash-sessions__empty')).toBeVisible()
  await expect(win.locator('.ix-dash-sync__value').first()).toHaveText('never')
  await expect(win.locator('.ix-dash-sync__value').nth(1)).toHaveText(/never|not set up/)
  await expect(win.locator('.ix-dash-row')).toHaveCount(0)

  // No zone threw: the region boundary never replaced the main area.
  await expect(win.locator('.ix-crash')).toHaveCount(0)

  await app.close()
})

/**
 * The timer is mounted on two surfaces, so it has to work on both. Started from zone 3 it must both
 * begin counting and change what the zone reports, which is the whole reason the zone exists.
 */
test('the timer starts from the Dashboard and the zone reflects it', async () => {
  const { app, win } = await launch(userDataDir())
  await expect(win.locator('.ix-dash')).toBeVisible()

  // Nothing has run yet, so an unconfigured profile logs nothing today.
  if (RUNS_ON_WEEKDAY) await expect(win.locator('.ix-dash-time__total')).toHaveText('0m')

  const action = win.locator('.ix-dash .ix-timer__action')
  await expect(action).toHaveText('Start')
  await action.click()

  await expect(action).toHaveText('Stop')
  await expect(win.locator('.ix-dash .ix-timer__elapsed')).toBeVisible()

  // A start-then-stop under a second is treated as a misclick and discarded, so let the span cross
  // that floor before stopping. Waiting on the ticking figure is the wait itself.
  await expect(win.locator('.ix-dash .ix-timer__elapsed')).toHaveText(
    /^(0:0[2-9]|0:[1-5]\d|[1-9]\d*:\d\d(:\d\d)?)$/
  )
  await action.click()
  await expect(action).toHaveText('Start')

  // Stopping logged the span against today, and the zone re-read the week rather than staying stale.
  if (RUNS_ON_WEEKDAY) await expect(win.locator('.ix-dash-time__total')).not.toHaveText('0m')
  await expect(win.locator('.ix-crash')).toHaveCount(0)

  await app.close()
})
