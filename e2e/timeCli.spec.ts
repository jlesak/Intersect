import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, launch, openRailSection, tempDir, test, userDataDir } from './harness'

function monday(): string {
  const now = new Date()
  now.setDate(now.getDate() - (now.getDay() + 6) % 7)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

test('installed CLI changes the open board and stops when the app closes', async () => {
  const home = tempDir('intersect-time-home-')
  const profile = userDataDir()
  const shim = join(home, '.local', 'bin', 'intersect-time')
  expect(existsSync(shim)).toBe(false)
  const { app, win } = await launch(profile, { env: { HOME: home } })
  await openRailSection(win, 'Settings', '.ix-settings')
  await win.locator('.ix-settings__nav-btn', { hasText: 'Time Tracking' }).click()
  await win.getByRole('button', { name: 'Install intersect-time CLI' }).click()
  await expect(win.getByRole('status')).toContainText(shim)
  expect(existsSync(shim)).toBe(true)

  const run = (...args: string[]) => spawnSync(shim, args, { encoding: 'utf8',
    env: { ...process.env, HOME: home }, timeout: 5_000 })
  const day = monday()
  await openRailSection(win, 'Time Tracking', '.ix-tt__board')
  const column = win.locator(`.ix-tt__day[data-day="${day}"]`)
  const first = run('add', '--actor', 'codex', '--day', day, '--duration', '30m',
    '--description', 'CLI first', '--issue', 'abc-1')
  expect(first.status, first.stderr).toBe(0)
  const firstRef = first.stdout.trim()
  await expect(column.locator('.ix-tt-card__title')).toHaveValue('CLI first')
  const second = run('add', '--actor', 'claude', '--day', day, '--duration', '20m',
    '--description', 'CLI second')
  expect(second.status, second.stderr).toBe(0)
  const secondRef = second.stdout.trim()
  await expect(column.locator('.ix-tt-card')).toHaveCount(2)
  const listed = run('list', '--day', day, '--json')
  expect(listed.status, listed.stderr).toBe(0)
  expect(JSON.parse(listed.stdout)).toEqual(expect.arrayContaining([
    expect.objectContaining({ ref: firstRef, source: 'manual', issueKey: 'ABC-1',
      description: 'CLI first', durationMs: 1_800_000 })
  ]))
  expect(run('edit', '--actor', 'user', firstRef, '--description', 'CLI edited').status).toBe(0)
  await expect(column.locator('.ix-tt-card__title').first()).toHaveValue('CLI edited')
  const grouped = run('group', '--actor', 'codex', firstRef, secondRef)
  expect(grouped.status, grouped.stderr).toBe(0)
  await expect(column.locator('.ix-tt-card')).toHaveCount(1)
  expect(run('ungroup', '--actor', 'user', grouped.stdout.trim()).status).toBe(0)
  await expect(column.locator('.ix-tt-card')).toHaveCount(2)
  expect(run('delete', '--actor', 'user', firstRef).status).toBe(0)
  await expect(column.locator('.ix-tt-card')).toHaveCount(1)
  await app.close()
  expect(run('list', '--day', day).status).toBe(3)
  expect(run('--help').status).toBe(0)
})
