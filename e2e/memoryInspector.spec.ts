import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, launch, openRailSection, tempDir, test, unconfiguredAdo, userDataDir } from './harness'

test('memory tab browses synthetic projects, searches bodies, follows local wikilinks, and stays read-only', async () => {
  const projects = tempDir('intersect-memory-projects-')
  const one = join(projects, '-Users-test-Alpha', 'memory')
  const two = join(projects, '-Users-test-Beta', 'memory')
  mkdirSync(one, { recursive: true })
  mkdirSync(two, { recursive: true })
  const index = join(one, 'MEMORY.md')
  const note = join(one, 'note.md')
  const other = join(two, 'note.md')
  writeFileSync(index, '# Index\n\n[[One]] and [[Missing]]')
  writeFileSync(note, '---\nname: One\ndescription: First memory\ntype: feedback\n---\nBody needle ![remote](https://example.invalid/pixel.png) ![local](file:///tmp/pixel.png) <img src="https://example.invalid/html.png">')
  writeFileSync(other, '---\nname: One\ntype: project\n---\nOther project')
  const before = [index, note, other].map((path) => readFileSync(path, 'utf8'))
  const { win, errors } = await launch(userDataDir(), {
    env: { ...unconfiguredAdo(), INTERSECT_CLAUDE_PROJECTS_DIR: projects }
  })
  const resourceRequests: string[] = []
  win.on('request', (request) => {
    if (/^https?:\/\//.test(request.url())) resourceRequests.push(request.url())
  })
  await openRailSection(win, 'Settings', '.ix-settings')
  await win.locator('.ix-settings__nav-btn', { hasText: 'Agent Tooling' }).click()
  await win.getByRole('tab', { name: 'Memory' }).click()
  const rail = win.getByLabel('Memory projects')
  await expect(rail.getByRole('button', { name: /All projects 3/ })).toBeVisible()
  await expect(rail.getByRole('button', { name: /Alpha 2/ })).toBeVisible()
  await rail.getByRole('button', { name: /Alpha 2/ }).click()
  await win.getByLabel('Search memories').fill('needle')
  await expect(win.getByLabel('Memories').getByRole('button', { name: /One/ })).toBeVisible()
  await expect(win.getByLabel('Memory preview')).toContainText('Body needle')
  await expect(win.getByLabel('Memory preview').locator('img')).toHaveCount(0)
  await win.getByLabel('Search memories').fill('')
  await win.getByLabel('Memories').getByRole('button', { name: /^MEMORY index/ }).click()
  await expect(win.getByLabel('Memory preview').getByRole('button', { name: 'One' })).toBeVisible()
  await expect(win.getByLabel('Memory preview').getByText('Missing')).toBeVisible()
  await win.getByLabel('Memory preview').getByRole('button', { name: 'One' }).click()
  await expect(win.getByLabel('Memory preview')).toContainText('Body needle')
  await win.getByRole('button', { name: 'Refresh' }).click()
  await expect(win.getByLabel('Memory preview')).toContainText('Body needle')
  expect(resourceRequests).toEqual([])
  expect([index, note, other].map((path) => readFileSync(path, 'utf8'))).toEqual(before)
  expect(errors).toEqual([])
})
