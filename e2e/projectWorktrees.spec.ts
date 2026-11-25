import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, launch, openRailSection, stubFolderPick, tempDir, test, unconfiguredAdo, userDataDir } from './harness'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
}

test('project worktrees show state and safely delete a linked checkout at minimum size', async () => {
  const root = tempDir('intersect-worktrees-e2e-')
  const repo = join(root, 'repo')
  const origin = join(root, 'origin.git')
  git(root, 'init', '--bare', origin)
  git(root, 'init', '-b', 'main', repo)
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(repo, '.gitignore'), '.claude/\n')
  git(repo, 'add', '.gitignore')
  git(repo, 'commit', '-m', 'initial')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-u', 'origin', 'main')
  const clean = join(repo, '.claude', 'worktrees', 'very-long-clean-worktree-folder')
  const dirty = join(repo, '.claude', 'worktrees', 'dirty')
  const cleanBranch = 'feature/very-long-worktree-branch-name-that-must-truncate'
  git(repo, 'worktree', 'add', '-b', cleanBranch, clean)
  git(repo, 'worktree', 'add', '-b', 'feature/dirty', dirty)
  writeFileSync(join(dirty, 'important-untracked-file.txt'), 'keep me')

  const { app, win, errors } = await launch(userDataDir(), { env: unconfiguredAdo() })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 600))
  await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getSize())).toEqual([940, 600])
  const content = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize())
  await expect.poll(() => win.evaluate(() => [innerWidth, innerHeight])).toEqual(content)

  await openRailSection(win, 'Settings', '.ix-settings')
  await stubFolderPick(app, repo)
  await win.getByRole('button', { name: 'Nový projekt (vybrat složku)' }).click()
  await win.locator('.ix-rail__btn--project').click()
  await win.getByRole('tab', { name: 'Worktrees' }).click()

  const table = win.locator('.ix-worktrees__table')
  await expect(table.locator('th')).toContainText(['Branch', 'Folder', 'Created', 'State', ''])
  await expect(table.locator('tbody tr')).toHaveCount(3)
  await expect(table.locator('tbody tr').first()).toContainText('main checkout')
  const cleanRow = table.locator('tbody tr', { hasText: cleanBranch })
  const dirtyRow = table.locator('tbody tr', { hasText: 'feature/dirty' })
  await expect(cleanRow).toContainText('clean')
  await expect(dirtyRow).toContainText('1 changed')
  await expect(cleanRow.locator('td').nth(2)).not.toHaveText('–')
  expect(await cleanRow.locator('td').nth(2).getAttribute('title')).toMatch(/\d{4}/)
  await expect(cleanRow.locator('td').nth(1)).toContainText('.claude/worktrees/')
  expect(await cleanRow.locator('td').first().locator('span').evaluate((el) =>
    el.scrollWidth > el.clientWidth)).toBe(true)
  expect(await win.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await win.locator('.ix-ctx__panel').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)

  await dirtyRow.getByRole('button', { name: 'Delete worktree feature/dirty' }).click()
  const dialog = win.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await expect(dialog).toContainText('important-untracked-file.txt')
  await expect(dialog.getByRole('button', { name: 'Discard changes and delete' })).toBeVisible()
  const buttonsInside = await dialog.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return rect.top >= 0 && rect.bottom <= innerHeight &&
      [...el.querySelectorAll('.ix-dialog__actions button')].every((button) => {
        const box = button.getBoundingClientRect()
        return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
      })
  })
  expect(buttonsInside).toBe(true)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  expect(existsSync(dirty)).toBe(true)

  const deleteClean = cleanRow.getByRole('button', { name: `Delete worktree ${cleanBranch}` })
  await cleanRow.hover()
  await expect(deleteClean).toHaveCSS('opacity', '1')
  await win.locator('.ix-ctx__toolbar').hover()
  await win.getByRole('button', { name: 'Refresh' }).focus()
  let reachedByTab = false
  const actions = await table.locator('tbody button').count()
  for (let i = 0; i < actions; i++) {
    await win.keyboard.press('Tab')
    if (await deleteClean.evaluate((button) => button === document.activeElement)) {
      reachedByTab = true
      break
    }
  }
  expect(reachedByTab).toBe(true)
  await expect(deleteClean).toHaveCSS('opacity', '1')
  await deleteClean.click()
  await expect(dialog.getByLabel(`Also delete branch ${cleanBranch}`)).toBeChecked()
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(cleanRow).toHaveCount(0)
  expect(existsSync(clean)).toBe(false)
  expect(git(repo, 'branch', '--list', cleanBranch)).toBe('')

  const added = join(repo, '.claude', 'worktrees', 'added-externally')
  git(repo, 'worktree', 'add', '-b', 'feature/added', added)
  await win.getByRole('button', { name: 'Refresh' }).click()
  await expect(table.locator('tbody tr')).toHaveCount(3)
  await expect(table).toContainText('feature/added')
  expect(errors).toEqual([])
})
