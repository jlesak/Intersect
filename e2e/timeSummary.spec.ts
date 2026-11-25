import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addDays, weekStartOf } from '../src/common/week'
import { expect, launch, openRailSection, tempDir, test, unconfiguredAdo, userDataDir } from './harness'

test('synthetic Haiku result appears on one card and work confirmation persists', async () => {
  const profile = userDataDir()
  const projects = tempDir('intersect-summary-projects-')
  const fixture = join(projects, 'synthetic-project')
  mkdirSync(fixture)
  const day = addDays(weekStartOf(Date.now()), -7)
  const at = (minute: number) => new Date(`${day}T09:${String(minute).padStart(2, '0')}:00`)
    .toISOString()
  writeFileSync(join(fixture, 'session.jsonl'), [
    { type: 'ai-title', aiTitle: 'Synthetic validation task' },
    { type: 'user', timestamp: at(0), cwd: '/synthetic/work/project',
      message: { content: 'Oprav validaci testovacího formuláře.' } },
    { type: 'assistant', timestamp: at(6), cwd: '/synthetic/work/project',
      message: { content: [{ type: 'text', text: 'Doplnil jsem testy validace.' }] } }
  ].map(record => JSON.stringify(record)).join('\n'))
  const fakeDir = tempDir('intersect-summary-fake-')
  const fake = join(fakeDir, 'claude')
  const calls = join(fakeDir, 'calls')
  const payload = JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    result: JSON.stringify({ summary: 'Oprava validace formuláře a doplnění testů.', isWork: false }) })
  writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\nprintf x >> '${calls}'\nprintf '%s' '${payload}'\n`)
  chmodSync(fake, 0o700)
  const { app, win, errors } = await launch(profile, { env: {
    ...unconfiguredAdo(), INTERSECT_CLAUDE_PROJECTS_DIR: projects,
    INTERSECT_TIME_SUMMARY_E2E_CLAUDE_PATH: fake
  } })
  const size = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(940, 600)
    return { outer: window.getSize(), content: window.getContentSize() }
  })
  expect(size.outer).toEqual([940, 600])
  await expect.poll(() => win.evaluate(() => [innerWidth, innerHeight])).toEqual(size.content)
  await openRailSection(win, 'Time Tracking', '.ix-tt__board')
  await win.locator('[title="Previous week"]').click()
  const card = win.locator(`.ix-tt__day[data-day="${day}"] .ix-tt-card`)
  await expect(card).toHaveCount(1)
  await expect(card.getByLabel('Description')).toHaveValue('Oprava validace formuláře a doplnění testů.')
  await expect(card.locator('.ix-tt-card__nonwork')).toHaveText('nepracovní')
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await card.click({ button: 'right' })
  await win.getByRole('menuitem', { name: 'Je pracovní' }).click()
  await expect(card.locator('.ix-tt-card__nonwork')).toHaveCount(0)
  await card.getByLabel('Description').fill('Vlastní popis práce')
  await card.getByLabel('Description').press('Enter')
  await card.click({ button: 'right' })
  await win.getByRole('menuitem', { name: 'Přegenerovat', exact: true }).click()
  await expect.poll(() => readFileSync(calls, 'utf8').length).toBe(2)
  await expect(card.getByLabel('Description')).toHaveValue('Vlastní popis práce')
  await expect(card.locator('.ix-tt-card__nonwork')).toHaveCount(0)
  expect(readdirSync(fixture)).toEqual(['session.jsonl'])
  expect(errors).toEqual([])
})
