import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const APP_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js')

/**
 * A fixture `~/.claude/projects`-shaped tree with two sessions in two folders, so the Sessions slice
 * has deterministic data to index, filter, read, and resume without touching the real user data.
 */
/** An ISO timestamp `daysAgo` days before now, so fixtures stay inside the default last-7-days filter. */
function isoDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
}

function buildProjectsFixture(cwdA: string, cwdB: string): string {
  const projectsDir = mkdtempSync(join(tmpdir(), 'intersect-sessions-'))
  const write = (folder: string, id: string, lines: object[]): void => {
    const dir = join(projectsDir, folder)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
  }

  write('proj-a', 'aaaaaaaa-1111-2222-3333-444444444444', [
    { type: 'ai-title', aiTitle: 'Building the widget factory', sessionId: 'a' },
    {
      type: 'user',
      message: { role: 'user', content: 'how do I build a widget factory' },
      timestamp: isoDaysAgo(1),
      cwd: cwdA,
      gitBranch: 'feature/widgets',
      isMeta: false
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'You assemble widgets with a **factory**.' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'factory.ts' } }
        ]
      },
      timestamp: isoDaysAgo(1),
      cwd: cwdA
    }
  ])

  write('proj-b', 'bbbbbbbb-5555-6666-7777-888888888888', [
    { type: 'ai-title', aiTitle: 'Fixing the login redirect', sessionId: 'b' },
    {
      type: 'user',
      message: { role: 'user', content: 'the login redirect loops forever' },
      timestamp: isoDaysAgo(3),
      cwd: cwdB,
      gitBranch: 'main',
      isMeta: false
    }
  ])

  return projectsDir
}

async function launch(userDataDir: string, projectsDir: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: [APP_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, INTERSECT_E2E: '1', INTERSECT_CLAUDE_PROJECTS_DIR: projectsDir }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.ix-wordmark__name')
  // Boot lands on Claude Code (formerly labeled Workspaces), the section these tests start from.
  await win.locator('.ix-rail__btn', { hasText: 'Claude Code' }).click()
  return { app, win }
}

async function openSessions(win: Page): Promise<void> {
  await win.locator('.ix-rail__btn', { hasText: 'Sessions' }).click()
  await win.locator('.ix-sessions-list').waitFor()
}

test('lists indexed sessions, filters by search, and reads a transcript', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const cwdA = mkdtempSync(join(tmpdir(), 'proj-a-'))
  const cwdB = mkdtempSync(join(tmpdir(), 'proj-b-'))
  const projectsDir = buildProjectsFixture(cwdA, cwdB)
  const { app, win } = await launch(userDataDir, projectsDir)

  await openSessions(win)

  // Both fixture sessions are indexed, newest activity first.
  await expect(win.locator('.ix-session-row')).toHaveCount(2)
  await expect(win.locator('.ix-session-row__title').first()).toHaveText('Building the widget factory')

  // Search narrows to the matching session by its user prompt text.
  await win.locator('.ix-sessions-search').fill('redirect')
  await expect(win.locator('.ix-session-row')).toHaveCount(1)
  await expect(win.locator('.ix-session-row__title')).toHaveText('Fixing the login redirect')

  // Clear the query, open the widget session, and read its transcript.
  await win.locator('.ix-sessions-search').fill('')
  await win.locator('.ix-session-row', { hasText: 'Building the widget factory' }).click()
  await expect(win.locator('.ix-transcript__title')).toHaveText('Building the widget factory')
  await expect(win.locator('.ix-transcript__body-scroll')).toContainText('assemble widgets')
  await expect(win.locator('.ix-transcript__tool')).toContainText('factory.ts')

  await app.close()
})

test('folder multiselect narrows the list to the checked folders', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const cwdA = mkdtempSync(join(tmpdir(), 'proj-a-'))
  const cwdB = mkdtempSync(join(tmpdir(), 'proj-b-'))
  const projectsDir = buildProjectsFixture(cwdA, cwdB)
  const { app, win } = await launch(userDataDir, projectsDir)

  await openSessions(win)
  await expect(win.locator('.ix-session-row')).toHaveCount(2)

  // Open the folder popover and uncheck the widget session's folder (proj-a-*).
  await win.locator('.ix-sessions-fbtn').click()
  await win.locator('.ix-sessions-folder__pop').waitFor()
  await win.locator('.ix-sessions-folder__item', { hasText: 'proj-a' }).locator('input').uncheck()

  await expect(win.locator('.ix-session-row')).toHaveCount(1)
  await expect(win.locator('.ix-session-row__title')).toHaveText('Fixing the login redirect')

  await app.close()
})

test('resume opens a Claude tab in a workspace for the session folder', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const cwdA = mkdtempSync(join(tmpdir(), 'proj-a-'))
  const cwdB = mkdtempSync(join(tmpdir(), 'proj-b-'))
  const projectsDir = buildProjectsFixture(cwdA, cwdB)
  const { app, win } = await launch(userDataDir, projectsDir)

  await openSessions(win)
  await win.locator('.ix-session-row', { hasText: 'Building the widget factory' }).click()
  await win.locator('.ix-transcript__header .ix-btn--primary', { hasText: 'Resume' }).click()

  // Resume reveals the Claude Code section, auto-creates a workspace for the session's cwd, and
  // opens a Claude tab there (the tab + terminal exist regardless of whether `claude` is installed).
  await expect(win.locator('.ix-ws--active')).toBeVisible()
  await expect(win.locator('.ix-tab')).toHaveCount(1)
  await expect(win.locator('.ix-tab__preset')).toHaveText('AI')
  await expect(win.locator('.xterm')).toBeVisible()

  await app.close()
})
