import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, launch, openRailSection, test, userDataDir } from './harness'

const EVIDENCE = process.env.EVIDENCE_DIR ?? tmpdir()

test('capture PR Review settings pane (default, edited, reset)', async () => {
  const { win } = await launch(userDataDir())

  await openRailSection(win, 'Settings', '.ix-settings')
  await win.locator('.ix-settings__nav-btn', { hasText: 'PR Review' }).click()

  // Default built-in prompt and the Opus default are shown.
  await expect(win.locator('#ix-set-review-prompt')).toHaveValue(/^Zrecenzuj pull request/)
  await expect(win.locator('#ix-set-review-model')).toHaveValue('opus')
  await win.screenshot({ path: join(EVIDENCE, 'review-pane-default.png') })

  // Replace with an arbitrary multiline English prompt (verbatim, incl. whitespace).
  const custom = 'Review this pull request in English.\n\nBe thorough. Keep this   spacing.\n'
  await win.locator('#ix-set-review-prompt').fill(custom)
  await expect(win.locator('#ix-set-review-prompt')).toHaveValue(custom)
  await win.screenshot({ path: join(EVIDENCE, 'review-pane-edited.png') })

  // Reset restores the built-in default.
  await win.getByRole('button', { name: 'Obnovit výchozí prompt a model' }).click()
  await expect(win.locator('#ix-set-review-prompt')).toHaveValue(/^Zrecenzuj pull request/)
  await win.screenshot({ path: join(EVIDENCE, 'review-pane-reset.png') })
})
