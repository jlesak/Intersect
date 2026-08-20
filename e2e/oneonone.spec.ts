import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ElectronApplication, type Page } from '@playwright/test'
import {
  expect,
  launch,
  openRailSection,
  RAIL_LABELS,
  tempDir,
  test,
  userDataDir
} from './harness'

async function openOneOnOne(win: Page): Promise<void> {
  await openRailSection(win, '1:1', '.ix-oto')
}

/** A real .vtt fixture on disk, so the main-side existence/extension validation passes. */
function writeVttFixture(): string {
  const dir = tempDir('intersect-oto-')
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

test('the 1:1 section sits between Other and TODO, and starts empty', async () => {
  const profileDir = userDataDir()
  const { win } = await launch(profileDir)

  await expect(win.locator('.ix-rail__label')).toHaveText([...RAIL_LABELS])

  await openOneOnOne(win)
  await expect(win.locator('.ix-empty__title')).toHaveText('No runs yet.')
  await expect(win.locator('.ix-oto-run')).toHaveCount(0)
})

test('the form opens from New and the VTT field follows the workflow type', async () => {
  const profileDir = userDataDir()
  const { win } = await launch(profileDir)
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
})

test('a process run goes running -> done and shows the Notion link and Slack confirmation', async () => {
  const profileDir = userDataDir()
  const { app, win } = await launch(profileDir)
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
  await expect(win.locator('.ix-oto-person__name')).toHaveText('Marek K.')
  await expect(card.locator('.ix-oto-run__status')).toHaveText(
    /Running in background \(Claude Code session\)…/
  )

  // Done: the status flips live and the result links appear.
  await expect(card.locator('.ix-oto-run__status--done')).toHaveText(/Done/)
  await expect(card.locator('.ix-oto-run__link', { hasText: 'Notion note' })).toHaveCount(1)
  await expect(card.locator('.ix-oto-run__link', { hasText: 'Slack summary created' })).toHaveCount(1)
})

test('a prepare run renders the briefing markdown on the card', async () => {
  const profileDir = userDataDir()
  const { win } = await launch(profileDir)
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
})

test('the run history persists across a relaunch', async () => {
  const profileDir = userDataDir()
  const first = await launch(profileDir)
  await openOneOnOne(first.win)

  await first.win.locator('.ix-oto__head .ix-btn--primary', { hasText: 'New' }).click()
  await first.win.locator('#oto-type').selectOption('prep')
  await first.win.getByPlaceholder('e.g. Marek K.').fill('Tereza N.')
  await first.win.locator('.ix-oto-form__actions .ix-btn--primary', { hasText: 'Start' }).click()
  await expect(first.win.locator('.ix-oto-run__status--done')).toHaveText(/Done/)
  await first.app.close()

  // Same profile: the finished run is still there with its result.
  const second = await launch(profileDir)
  await openOneOnOne(second.win)
  const card = second.win.locator('.ix-oto-run')
  await expect(card).toHaveCount(1)
  await expect(second.win.locator('.ix-oto-person__name')).toHaveText('Tereza N.')
  await expect(card.locator('.ix-oto-run__status--done')).toHaveText(/Done/)
  await expect(card.locator('.ix-oto-prep-body .ix-markdown h2').first()).toHaveText('Previous 1:1')
})

test('a run interrupted by an app restart is reconciled to failed on boot', async () => {
  const profileDir = userDataDir()
  const first = await launch(profileDir, { env: { INTERSECT_E2E_OTO: 'running' } })
  await openOneOnOne(first.win)

  await first.win.locator('.ix-oto__head .ix-btn--primary', { hasText: 'New' }).click()
  await first.win.locator('#oto-type').selectOption('prep')
  await first.win.getByPlaceholder('e.g. Marek K.').fill('Aleš P.')
  await first.win.locator('.ix-oto-form__actions .ix-btn--primary', { hasText: 'Start' }).click()
  await expect(first.win.locator('.ix-oto-run__status')).toHaveText(/Running in background/)
  await first.app.close()

  const second = await launch(profileDir)
  await openOneOnOne(second.win)
  await expect(second.win.locator('.ix-oto-run__status--failed')).toHaveText(
    /Failed: Interrupted by app restart/
  )
})

test('failed mode shows the error on the card', async () => {
  const profileDir = userDataDir()
  const { win } = await launch(profileDir, { env: { INTERSECT_E2E_OTO: 'failed' } })
  await openOneOnOne(win)

  await win.locator('.ix-oto__head .ix-btn--primary', { hasText: 'New' }).click()
  await win.locator('#oto-type').selectOption('prep')
  await win.getByPlaceholder('e.g. Marek K.').fill('Tereza N.')
  await win.locator('.ix-oto-form__actions .ix-btn--primary', { hasText: 'Start' }).click()

  await expect(win.locator('.ix-oto-run__status--failed')).toHaveText(
    /Failed: Stubbed workflow failure/
  )
  await expect(win.locator('.ix-oto-run__link')).toHaveCount(0)
})

test('a failed run starts again from its own card, and the failure stays in the history', async () => {
  const profileDir = userDataDir()
  const { win } = await launch(profileDir, { env: { INTERSECT_E2E_OTO: 'failed' } })
  await openOneOnOne(win)

  await win.locator('.ix-oto__head .ix-btn--primary', { hasText: 'New' }).click()
  await win.locator('#oto-type').selectOption('prep')
  await win.getByPlaceholder('e.g. Marek K.').fill('Tereza N.')
  await win.locator('.ix-oto-form__actions .ix-btn--primary', { hasText: 'Start' }).click()
  await expect(win.locator('.ix-oto-run__status--failed')).toHaveCount(1)

  // The card still holds the type and the person the form was given, so Retry needs no re-entry.
  await win.locator('.ix-oto-run .ix-btn', { hasText: 'Retry' }).click()
  await expect(win.locator('.ix-oto-run')).toHaveCount(2)
  await expect(win.locator('.ix-oto-run__type')).toHaveText([/preparation/i, /preparation/i])
  await expect(win.locator('.ix-oto-run__status--failed')).toHaveCount(2)

  // Both runs are the same person, so the history keeps them under one name.
  await expect(win.locator('.ix-oto-person__name')).toHaveText(['Tereza N.'])
})

test('the person field offers a name the run history already used', async () => {
  const profileDir = userDataDir()
  const { win } = await launch(profileDir)
  await openOneOnOne(win)

  await win.locator('.ix-oto__head .ix-btn--primary', { hasText: 'New' }).click()
  await win.locator('#oto-type').selectOption('prep')
  await win.getByPlaceholder('e.g. Marek K.').fill('Tereza N.')
  await win.locator('.ix-oto-form__actions .ix-btn--primary', { hasText: 'Start' }).click()
  await expect(win.locator('.ix-oto-run__status--done')).toHaveText(/Done/)

  // The next run is offered that person instead of asking for the spelling again.
  await win.locator('.ix-oto__head .ix-btn--primary', { hasText: 'New' }).click()
  await expect(win.locator('#oto-person')).toHaveAttribute('list', 'oto-people')
  await expect(win.locator('#oto-people option')).toHaveCount(1)
  await expect(win.locator('#oto-people option')).toHaveAttribute('value', 'Tereza N.')
})

test('an empty person is rejected inline and no run starts', async () => {
  const profileDir = userDataDir()
  const { win } = await launch(profileDir)
  await openOneOnOne(win)

  await win.locator('.ix-oto__head .ix-btn--primary', { hasText: 'New' }).click()
  await win.locator('#oto-type').selectOption('prep')
  await win.locator('.ix-oto-form__actions .ix-btn--primary', { hasText: 'Start' }).click()

  await expect(win.locator('.ix-oto-form__error')).toHaveText(/Person must not be empty/)
  await expect(win.locator('.ix-oto-form')).toHaveCount(1)
  await expect(win.locator('.ix-oto-run')).toHaveCount(0)
})
