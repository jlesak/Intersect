import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const APP_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js')

async function launch(
  userDataDir: string,
  extraEnv: Record<string, string> = {}
): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: [APP_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, INTERSECT_E2E: '1', ...extraEnv }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.ix-wordmark__name')
  return { app, win }
}

async function openOneOnOne(win: Page): Promise<void> {
  await win.locator('.ix-rail__btn', { hasText: '1:1' }).click()
  await win.locator('.ix-oto').waitFor()
}

/** A real .vtt fixture on disk, so the main-side existence/extension validation passes. */
function writeVttFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'intersect-oto-'))
  const path = join(dir, 'marek-1-1.vtt')
  writeFileSync(path, 'WEBVTT\n\n00:00.000 --> 00:05.000\n<v Jan Lesák>Ahoj\n')
  return path
}

/** Point the native open dialog at the fixture so click-to-pick works without UI. */
async function stubVttDialog(app: ElectronApplication, vttPath: string): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path]
    })
  }, vttPath)
}

test('the 1:1 section sits between TODO and PR Review and starts empty', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const { app, win } = await launch(userDataDir)

  await expect(win.locator('.ix-rail__label')).toHaveText([
    'Claude Code',
    'My Work',
    'Time Tracking',
    'TODO',
    '1:1',
    'PR Review',
    'Sessions',
    'Settings'
  ])

  await openOneOnOne(win)
  await expect(win.locator('.ix-empty__title')).toHaveText('No runs yet.')
  await expect(win.locator('.ix-oto-run')).toHaveCount(0)

  await app.close()
})

test('the form opens from New and the VTT field follows the workflow type', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const { app, win } = await launch(userDataDir)
  await openOneOnOne(win)

  // No form until New is clicked.
  await expect(win.locator('.ix-oto-form')).toHaveCount(0)
  await win.locator('.ix-oto__head .ix-btn--primary', { hasText: 'New' }).click()
  await expect(win.locator('.ix-oto-form')).toHaveCount(1)

  // Process (default) shows the VTT dropzone; Prepare hides it.
  await expect(win.locator('.ix-oto-form__file')).toHaveText(/Drop a VTT file or click to choose…/)
  await win.locator('#oto-type').selectOption('prep')
  await expect(win.locator('.ix-oto-form__file')).toHaveCount(0)
  await win.locator('#oto-type').selectOption('process')
  await expect(win.locator('.ix-oto-form__file')).toHaveCount(1)

  // Cancel closes the form without starting anything.
  await win.locator('.ix-oto-form__actions .ix-btn--ghost', { hasText: 'Cancel' }).click()
  await expect(win.locator('.ix-oto-form')).toHaveCount(0)
  await expect(win.locator('.ix-oto-run')).toHaveCount(0)

  await app.close()
})

test('a process run goes running -> done and shows the Notion link and Slack confirmation', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const { app, win } = await launch(userDataDir)
  await stubVttDialog(app, writeVttFixture())
  await openOneOnOne(win)

  await win.locator('.ix-oto__head .ix-btn--primary', { hasText: 'New' }).click()
  await win.getByPlaceholder('e.g. Marek K.').fill('Marek K.')
  await win.locator('.ix-oto-form__file').click()
  await expect(win.locator('.ix-oto-form__file')).toHaveText(/marek-1-1\.vtt/)
  await win.locator('.ix-oto-form__actions .ix-btn--primary', { hasText: 'Start' }).click()

  // The card appears immediately in the running state (the stub resolves after a short delay).
  const card = win.locator('.ix-oto-run')
  await expect(card).toHaveCount(1)
  await expect(card.locator('.ix-oto-run__type')).toHaveText(/processing/i)
  await expect(card.locator('.ix-oto-run__person')).toHaveText('Marek K.')
  await expect(card.locator('.ix-oto-run__status')).toHaveText(
    /Running in background \(Claude Code session\)…/
  )

  // Done: the status flips live and the result links appear.
  await expect(card.locator('.ix-oto-run__status--done')).toHaveText(/Done/)
  await expect(card.locator('.ix-oto-run__link', { hasText: 'Notion note' })).toHaveCount(1)
  await expect(card.locator('.ix-oto-run__link', { hasText: 'Slack summary created' })).toHaveCount(1)

  await app.close()
})

test('a prepare run renders the briefing markdown on the card', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const { app, win } = await launch(userDataDir)
  await openOneOnOne(win)

  await win.locator('.ix-oto__head .ix-btn--primary', { hasText: 'New' }).click()
  await win.locator('#oto-type').selectOption('prep')
  await win.getByPlaceholder('e.g. Marek K.').fill('Tereza N.')
  await win.locator('.ix-oto-form__actions .ix-btn--primary', { hasText: 'Start' }).click()

  const card = win.locator('.ix-oto-run')
  await expect(card.locator('.ix-oto-run__type')).toHaveText(/preparation/i)
  await expect(card.locator('.ix-oto-run__status--done')).toHaveText(/Done/)

  // The stub markdown renders as real HTML: headings and bullet points, no raw ## markers.
  const markdown = card.locator('.ix-oto-prep-body .ix-markdown')
  await expect(markdown.locator('h2', { hasText: 'Previous 1:1' })).toHaveCount(1)
  await expect(markdown.locator('h2', { hasText: 'TODO mentions' })).toHaveCount(1)
  await expect(markdown.locator('h2', { hasText: 'Slack activity' })).toHaveCount(1)
  await expect(markdown.locator('li', { hasText: 'Ask Tereza N. about the rate limit fix' })).toHaveCount(1)

  await app.close()
})

test('the run history persists across a relaunch', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const first = await launch(userDataDir)
  await openOneOnOne(first.win)

  await first.win.locator('.ix-oto__head .ix-btn--primary', { hasText: 'New' }).click()
  await first.win.locator('#oto-type').selectOption('prep')
  await first.win.getByPlaceholder('e.g. Marek K.').fill('Tereza N.')
  await first.win.locator('.ix-oto-form__actions .ix-btn--primary', { hasText: 'Start' }).click()
  await expect(first.win.locator('.ix-oto-run__status--done')).toHaveText(/Done/)
  await first.app.close()

  // Same profile: the finished run is still there with its result.
  const second = await launch(userDataDir)
  await openOneOnOne(second.win)
  const card = second.win.locator('.ix-oto-run')
  await expect(card).toHaveCount(1)
  await expect(card.locator('.ix-oto-run__person')).toHaveText('Tereza N.')
  await expect(card.locator('.ix-oto-run__status--done')).toHaveText(/Done/)
  await expect(card.locator('.ix-oto-prep-body .ix-markdown h2').first()).toHaveText('Previous 1:1')
  await second.app.close()
})

test('a run interrupted by an app restart is reconciled to failed on boot', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const first = await launch(userDataDir, { INTERSECT_E2E_OTO: 'running' })
  await openOneOnOne(first.win)

  await first.win.locator('.ix-oto__head .ix-btn--primary', { hasText: 'New' }).click()
  await first.win.locator('#oto-type').selectOption('prep')
  await first.win.getByPlaceholder('e.g. Marek K.').fill('Aleš P.')
  await first.win.locator('.ix-oto-form__actions .ix-btn--primary', { hasText: 'Start' }).click()
  await expect(first.win.locator('.ix-oto-run__status')).toHaveText(/Running in background/)
  await first.app.close()

  const second = await launch(userDataDir)
  await openOneOnOne(second.win)
  await expect(second.win.locator('.ix-oto-run__status--failed')).toHaveText(
    /Failed: Interrupted by app restart/
  )
  await second.app.close()
})

test('failed mode shows the error on the card', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const { app, win } = await launch(userDataDir, { INTERSECT_E2E_OTO: 'failed' })
  await openOneOnOne(win)

  await win.locator('.ix-oto__head .ix-btn--primary', { hasText: 'New' }).click()
  await win.locator('#oto-type').selectOption('prep')
  await win.getByPlaceholder('e.g. Marek K.').fill('Tereza N.')
  await win.locator('.ix-oto-form__actions .ix-btn--primary', { hasText: 'Start' }).click()

  await expect(win.locator('.ix-oto-run__status--failed')).toHaveText(
    /Failed: Stubbed workflow failure/
  )
  await expect(win.locator('.ix-oto-run__link')).toHaveCount(0)

  await app.close()
})

test('an empty person is rejected inline and no run starts', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const { app, win } = await launch(userDataDir)
  await openOneOnOne(win)

  await win.locator('.ix-oto__head .ix-btn--primary', { hasText: 'New' }).click()
  await win.locator('#oto-type').selectOption('prep')
  await win.locator('.ix-oto-form__actions .ix-btn--primary', { hasText: 'Start' }).click()

  await expect(win.locator('.ix-oto-form__error')).toHaveText(/Person must not be empty/)
  await expect(win.locator('.ix-oto-form')).toHaveCount(1)
  await expect(win.locator('.ix-oto-run')).toHaveCount(0)

  await app.close()
})
