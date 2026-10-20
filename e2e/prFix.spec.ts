import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ElectronApplication, type Page } from '@playwright/test'
import {
  addWorkspace,
  expect,
  launch,
  openRailSection,
  stubQuitConfirm,
  tempDir,
  test,
  unconfiguredAdo,
  userDataDir
} from './harness'

/**
 * Fixing the review comments of my own pull request, end to end. The pull requests and their
 * threads come from the canned Azure DevOps backend (PR 501 is mine and carries one open reviewer
 * thread; PR 502 is a review I owe), while git is real: a bare origin named like the canned
 * repository, a clone of it added as a workspace, and the worktree the app makes from it. `claude`
 * is a stand-in on PATH that records what it was started with, so the spec can see the flags and
 * the first message without a real Claude Code installed.
 */

const BRANCH = 'feature/rate-limit'
const THREAD_BODY = 'Should the limit be configurable?'

interface Fixture {
  cloneDir: string
  binDir: string
  argsLog: string
  spawnsLog: string
}

const git = (cwd: string, args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', '-C', cwd, ...args],
    { encoding: 'utf8' }
  )

/** A bare origin with the pull request's source branch, a clone of it, and the fake `claude`. */
function makeFixture(): Fixture {
  const root = tempDir('intersect-prfix-')
  const origin = join(root, 'intersect-app.git')
  const seed = join(root, 'seed')
  const cloneDir = join(root, 'intersect-app')
  git(root, ['init', '--quiet', '--bare', '--initial-branch=main', origin])
  git(root, ['init', '--quiet', '--initial-branch=main', seed])
  writeFileSync(join(seed, 'README.md'), 'intersect-app\n')
  git(seed, ['add', '.'])
  git(seed, ['commit', '--quiet', '-m', 'init'])
  git(seed, ['checkout', '--quiet', '-b', BRANCH])
  mkdirSync(join(seed, 'src', 'app', 'sync'), { recursive: true })
  writeFileSync(join(seed, 'src', 'app', 'sync', 'rateLimiter.ts'), 'export const limit = 25\n')
  git(seed, ['add', '.'])
  git(seed, ['commit', '--quiet', '-m', 'rate limit'])
  git(seed, ['remote', 'add', 'origin', origin])
  git(seed, ['push', '--quiet', 'origin', 'main', BRANCH])
  git(root, ['clone', '--quiet', origin, cloneDir])

  const binDir = join(root, 'bin')
  const argsLog = join(root, 'claude-args.log')
  const spawnsLog = join(root, 'claude-spawns.log')
  mkdirSync(binDir)
  const fake = join(binDir, 'claude')
  // Every argument goes to the log whole; the terminal gets a one-line marker per argument, so the
  // flags stay on screen however long the first message is. Each start also records where it ran,
  // for which tab, and the first line of its last argument (the first message, when there is one).
  writeFileSync(
    fake,
    [
      '#!/bin/sh',
      `for arg in "$@"; do printf '%s\\n' "$arg" >> '${argsLog}'; done`,
      'last=""; for arg in "$@"; do last="$arg"; done',
      `printf '%s\\t%s\\t%s\\n' "$(pwd -P)" "$INTERSECT_INSTANCE_ID" "$(printf '%s\\n' "$last" | head -n 1)" >> '${spawnsLog}'`,
      `for arg in "$@"; do printf 'FAKE-CLAUDE %s\\n' "$arg" | head -n 1; done`,
      ''
    ].join('\n')
  )
  chmodSync(fake, 0o755)
  return { cloneDir, binDir, argsLog, spawnsLog }
}

interface ClaudeStart {
  cwd: string
  instanceId: string
  lastArgFirstLine: string
}

/** Every start of the Claude stand-in so far, in order. */
function claudeStarts(fixture: Fixture): ClaudeStart[] {
  if (!existsSync(fixture.spawnsLog)) return []
  return readFileSync(fixture.spawnsLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [cwd = '', instanceId = '', lastArgFirstLine = ''] = line.split('\t')
      return { cwd, instanceId, lastArgFirstLine }
    })
}

async function launchWithClone(
  fixture: Fixture
): Promise<{ app: ElectronApplication; win: Page; profileDir: string }> {
  const profileDir = userDataDir()
  const { app, win } = await launch(profileDir, {
    openOther: true,
    env: {
      ...unconfiguredAdo(),
      INTERSECT_E2E_ADO: 'radar',
      PATH: `${fixture.binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`
    }
  })
  // The fix tab's shell outlives the stand-in, so quitting would ask to suspend it.
  await stubQuitConfirm(app)
  // The detail header holds several actions; CI's default window is too narrow to be sure of them.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await addWorkspace(win, app, fixture.cloneDir)
  return { app, win, profileDir }
}

async function openPr(win: Page, title: string): Promise<void> {
  await openRailSection(win, 'PR Review', '.ix-board-head')
  await win.getByTestId('pr-tab-all').click()
  await win.getByTestId('pr-row').filter({ hasText: title }).click()
  await expect(win.locator('.ix-pr-header__title')).toContainText(title)
}

/** The worktree the app makes for PR 501, in the canonical form git records it under. */
const fixPathOf = (profileDir: string): string =>
  join(realpathSync(profileDir), 'pr-fix-worktrees', 'intersect-app-pr501')

/** Start the fix from PR 501's detail and wait for the Claude stand-in to have run. */
async function startFix(win: Page, fixture: Fixture): Promise<void> {
  await openPr(win, 'Add rate limiting')
  await win.getByTestId('pr-fix-comments').click()
  await expect(win.locator('.ix-ws--active .ix-ws__name')).toHaveText('intersect-app-pr501')
  await expect(win.locator('.xterm-rows')).toContainText('FAKE-CLAUDE --permission-mode', {
    timeout: 20_000
  })
  await expect.poll(() => existsSync(fixture.argsLog)).toBe(true)
}

test('only my own pull request offers the fix, once, counting the open reviewer threads', async () => {
  const fixture = makeFixture()
  const { win } = await launchWithClone(fixture)

  await openRailSection(win, 'PR Review', '.ix-board-head')
  await win.getByTestId('pr-sync').click()
  await win.getByTestId('pr-tab-all').click()
  await expect(win.getByTestId('pr-row')).toHaveCount(3)
  // No bulk action: the board itself carries no fix control.
  await expect(win.getByTestId('pr-fix-comments')).toHaveCount(0)

  await win.getByTestId('pr-row').filter({ hasText: 'Fix PTY backpressure' }).click()
  await expect(win.locator('.ix-pr-header__title')).toContainText('Fix PTY backpressure')
  await expect(win.getByTestId('pr-fix-comments')).toHaveCount(0)

  await win.getByTestId('pr-back').click()
  await win.getByTestId('pr-tab-all').click()
  await win.getByTestId('pr-row').filter({ hasText: 'Add rate limiting' }).click()
  await expect(win.getByTestId('pr-fix-comments')).toHaveText('Fix review comments · 1')
  await expect(win.getByTestId('pr-fix-comments')).toHaveCount(1)
})

test('the fix opens Claude on the PR branch in its own worktree, and a clean close removes it', async () => {
  const fixture = makeFixture()
  const { win, profileDir } = await launchWithClone(fixture)
  const fixPath = fixPathOf(profileDir)
  await openRailSection(win, 'PR Review', '.ix-board-head')
  await win.getByTestId('pr-sync').click()

  await startFix(win, fixture)

  // One Claude tab, named after the pull request and carrying it as its work item.
  await expect(win.locator('.ix-tab')).toHaveCount(1)
  await expect(win.locator('.ix-tab__title')).toHaveText('PR !501')
  await expect(win.locator('.ix-tab__workitem')).toHaveText('!501')

  // Claude was started with standard permission prompts and the open thread as its first message.
  const args = readFileSync(fixture.argsLog, 'utf8')
  expect(args).toContain('--permission-mode\ndefault\n')
  expect(args).toContain(THREAD_BODY)
  expect(args).toContain('/src/app/sync/rateLimiter.ts')

  // The worktree is on the source branch; the clone itself stayed on main.
  const listed = git(fixture.cloneDir, ['worktree', 'list', '--porcelain'])
  expect(listed).toContain(`worktree ${fixPath}\n`)
  expect(listed).toContain(`branch refs/heads/${BRANCH}`)
  expect(git(fixture.cloneDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main')

  // Closing the last tab answers at once; the folder and its workspace follow once git is done.
  await win.locator('.ix-tab__close').click()
  await expect(win.locator('.ix-tab')).toHaveCount(0)
  await expect.poll(() => existsSync(fixPath), { timeout: 20_000 }).toBe(false)
  await expect(win.locator('.ix-ws__name', { hasText: 'intersect-app-pr501' })).toHaveCount(0)
  expect(git(fixture.cloneDir, ['worktree', 'list', '--porcelain'])).not.toContain(fixPath)
})

test('a worktree with untracked files is kept on close, and the toast says why', async () => {
  const fixture = makeFixture()
  const { win, profileDir } = await launchWithClone(fixture)
  const fixPath = fixPathOf(profileDir)
  await openRailSection(win, 'PR Review', '.ix-board-head')
  await win.getByTestId('pr-sync').click()

  await startFix(win, fixture)
  writeFileSync(join(fixPath, 'notes.txt'), 'work in progress\n')

  await win.locator('.ix-tab__close').click()

  const kept = win.locator('.ix-toast', { hasText: 'uncommitted or untracked files' })
  await expect(kept).toBeVisible({ timeout: 20_000 })
  await expect(kept).toContainText(fixPath)
  expect(existsSync(join(fixPath, 'notes.txt'))).toBe(true)
  await expect(win.locator('.ix-ws__name', { hasText: 'intersect-app-pr501' })).toHaveCount(1)
})

/**
 * The everyday path: a Claude tab is already open in the clone when the fix starts. Switching to
 * the new workspace once started a stray Claude in the worktree under the clone tab's id; it took
 * the first message, and the session nobody owned kept the worktree from ever being removed.
 */
test('starting the fix from a workspace with an open Claude tab starts exactly one Claude', async () => {
  const fixture = makeFixture()
  const { win, profileDir } = await launchWithClone(fixture)
  const fixPath = fixPathOf(profileDir)
  await win.locator('.ix-iconbtn[title="New terminal"]').click()
  await win.locator('.ix-preset', { hasText: 'Claude Code' }).click()
  await expect.poll(() => claudeStarts(fixture).map((s) => s.cwd)).toEqual([
    realpathSync(fixture.cloneDir)
  ])
  await openRailSection(win, 'PR Review', '.ix-board-head')
  await win.getByTestId('pr-sync').click()

  await startFix(win, fixture)

  await expect(win.locator('.ix-tab')).toHaveCount(1)
  const fixTabId = await win.locator('.ix-tab').getAttribute('data-tab-id')
  const inWorktree = claudeStarts(fixture).filter((s) => s.cwd === fixPath)
  expect(inWorktree).toHaveLength(1)
  // The one Claude in the worktree is the visible tab's, and it got the comment list.
  expect(inWorktree[0].instanceId.endsWith(`:${fixTabId}`)).toBe(true)
  expect(inWorktree[0].lastArgFirstLine).toContain('pull request !501')

  await win.locator('.ix-tab__close').click()
  await expect(win.locator('.ix-tab')).toHaveCount(0)
  await expect.poll(() => existsSync(fixPath), { timeout: 20_000 }).toBe(false)
  await expect(win.locator('.ix-ws__name', { hasText: 'intersect-app-pr501' })).toHaveCount(0)
})
