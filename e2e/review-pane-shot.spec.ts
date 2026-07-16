import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

const APP_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js')
const EVIDENCE = process.env.EVIDENCE_DIR ?? tmpdir()

test('capture PR Review settings pane (default, edited, reset)', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-shot-'))
  const app = await electron.launch({
    args: [APP_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, INTERSECT_E2E: '1' }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.ix-wordmark__name')

  await win.locator('.ix-rail__foot .ix-rail__btn', { hasText: 'Settings' }).click()
  await win.locator('.ix-settings').waitFor()
  await win.locator('.ix-settings__nav-btn', { hasText: 'PR Review' }).click()

  // Default built-in prompt is shown.
  await expect(win.locator('#ix-set-review-prompt')).toHaveValue(/^Zrecenzuj pull request/)
  await win.screenshot({ path: join(EVIDENCE, 'review-pane-default.png') })

  // Replace with an arbitrary multiline English prompt (verbatim, incl. whitespace).
  const custom = 'Review this pull request in English.\n\nBe thorough. Keep this   spacing.\n'
  await win.locator('#ix-set-review-prompt').fill(custom)
  await expect(win.locator('#ix-set-review-prompt')).toHaveValue(custom)
  await win.screenshot({ path: join(EVIDENCE, 'review-pane-edited.png') })

  // Reset restores the built-in default.
  await win.getByRole('button', { name: 'Obnovit výchozí prompt' }).click()
  await expect(win.locator('#ix-set-review-prompt')).toHaveValue(/^Zrecenzuj pull request/)
  await win.screenshot({ path: join(EVIDENCE, 'review-pane-reset.png') })

  await app.close()
})
