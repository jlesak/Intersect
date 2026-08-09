import { expect, launch, test, userDataDir } from './harness'

test('app launches and renders the shell', async () => {
  const { app, win, errors } = await launch(userDataDir())

  await expect(win.locator('.ix-wordmark__name')).toHaveText('Intersect')

  // Boot lands on the Dashboard - the first main-owning section - so its four zones are the very
  // first thing the app renders, and every one of them must survive a profile with nothing set up.
  await expect(win.locator('.ix-dash-zone__title')).toHaveText([
    'Needs action',
    'Running sessions',
    'Time today',
    'System status'
  ])

  // Switching to My Work renders the stubbed E2E board's empty state.
  await win.locator('.ix-rail__btn', { hasText: 'My Work' }).click()
  await expect(win.locator('.ix-mw-empty-inline')).toBeVisible()

  // Closed here rather than left to the harness because shutdown is part of what is being read:
  // `errors` is inspected on the next line, and anything the renderer logs on its way out only
  // reaches it while the window is still being listened to.
  await app.close()
  expect(errors, `renderer console errors:\n${errors.join('\n')}`).toEqual([])
})
