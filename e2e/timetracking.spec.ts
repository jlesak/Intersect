import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const APP_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js')

/** The local `yyyy-mm-dd` day key of a Date (mirrors the app's local-calendar bucketing). */
function dayKey(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** This week's weekday at the given offset from Monday (0 = Monday), computed from Date.now(). */
function weekdayThisWeek(offsetFromMonday: number): string {
  const now = new Date()
  const sinceMonday = (now.getDay() + 6) % 7
  return dayKey(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday + offsetFromMonday)
  )
}

/** An ISO timestamp at a local time of day on the given day key. */
function isoAt(day: string, hour: number, minute = 0): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, hour, minute).toISOString()
}

// The fixture's three sessions, placed relative to the current week at test runtime: Monday and
// Tuesday cards (durations 1h 45m and 55m) plus a Saturday session that must never appear.
const MONDAY = weekdayThisWeek(0)
const TUESDAY = weekdayThisWeek(1)
const WEDNESDAY = weekdayThisWeek(2)
const SATURDAY = weekdayThisWeek(5)

/**
 * A fixture `~/.claude/projects`-shaped tree with sessions at known weekdays/durations/branches of
 * the current week, so the board has deterministic auto entries without touching real user data.
 */
function buildProjectsFixture(): string {
  const projectsDir = mkdtempSync(join(tmpdir(), 'intersect-tt-'))
  const write = (folder: string, id: string, lines: object[]): void => {
    const dir = join(projectsDir, folder)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
  }

  const session = (
    title: string,
    day: string,
    startHour: number,
    minutes: number,
    gitBranch: string
  ): object[] => [
    { type: 'ai-title', aiTitle: title },
    {
      type: 'user',
      message: { role: 'user', content: 'do the work' },
      timestamp: isoAt(day, startHour),
      cwd: '/tmp/proj',
      gitBranch,
      isMeta: false
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      timestamp: isoAt(day, startHour, minutes),
      cwd: '/tmp/proj'
    }
  ]

  write(
    'proj-a',
    'aaaaaaaa-1111-2222-3333-444444444444',
    session('Lock owner on the card', MONDAY, 9, 105, 'feature/fid2507-611-lock-owner')
  )
  write(
    'proj-a',
    'bbbbbbbb-5555-6666-7777-888888888888',
    session('Board scaffolding', TUESDAY, 13, 55, 'feature/time-tracking')
  )
  write(
    'proj-b',
    'cccccccc-9999-aaaa-bbbb-cccccccccccc',
    session('Weekend experiment', SATURDAY, 10, 60, 'feature/fid2507-999-weekend')
  )

  return projectsDir
}

async function launch(
  userDataDir: string,
  projectsDir: string
): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: [APP_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, INTERSECT_E2E: '1', INTERSECT_CLAUDE_PROJECTS_DIR: projectsDir }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.ix-wordmark__name')
  return { app, win }
}

async function openTimeTracking(win: Page): Promise<void> {
  await win.locator('.ix-rail__btn', { hasText: 'Time Tracking' }).click()
  await win.locator('.ix-tt__board').waitFor()
}

const dayColumn = (win: Page, day: string) => win.locator(`.ix-tt__day[data-day="${day}"]`)

// The TODAY badge only exists when the suite runs on a weekday; a weekend run shows the current
// week without a highlighted column.
const RUNS_ON_WEEKDAY = ![0, 6].includes(new Date().getDay())

test('the section sits second in the rail and shows the week with auto cards in their days', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const { app, win } = await launch(userDataDir, buildProjectsFixture())

  // Sidebar order: My Work, Time Tracking, Workspaces, PR Review, Sessions.
  await expect(win.locator('.ix-rail__label')).toHaveText([
    'My Work',
    'Time Tracking',
    'Workspaces',
    'PR Review',
    'Sessions'
  ])

  await openTimeTracking(win)

  // Five weekday columns Monday through Friday, today's highlighted.
  await expect(win.locator('.ix-tt__day')).toHaveCount(5)
  await expect(win.locator('.ix-tt__day-name')).toHaveText([
    /Monday/,
    /Tuesday/,
    /Wednesday/,
    /Thursday/,
    /Friday/
  ])
  if (RUNS_ON_WEEKDAY) {
    await expect(win.locator('.ix-tt__day--today')).toHaveCount(1)
    await expect(win.locator('.ix-tt__day--today .ix-tt__day-badge')).toHaveText('TODAY')
  }

  // The Monday session card: derived issue key, title, and duration; day total matches.
  const monday = dayColumn(win, MONDAY)
  await expect(monday.locator('.ix-tt-card')).toHaveCount(1)
  await expect(monday.locator('.ix-tt-card__key')).toHaveValue('FID2507-611')
  await expect(monday.locator('.ix-tt-card__title')).toHaveText('Lock owner on the card')
  await expect(monday.locator('.ix-tt-card__dur')).toHaveValue('1h 45m')
  await expect(monday.locator('.ix-tt__day-total')).toHaveText('1h 45m')

  // The Tuesday session has no key in its branch: empty editable key showing "no issue".
  const tuesday = dayColumn(win, TUESDAY)
  await expect(tuesday.locator('.ix-tt-card__key')).toHaveValue('')
  await expect(tuesday.locator('.ix-tt-card__key')).toHaveAttribute('placeholder', 'no issue')
  await expect(tuesday.locator('.ix-tt-card__dur')).toHaveValue('55m')

  // The Saturday session is excluded entirely: two cards on the whole board, weekend not counted.
  await expect(win.locator('.ix-tt-card')).toHaveCount(2)
  await expect(win.locator('.ix-tt__total')).toHaveText('2h 40m total')

  await app.close()
})

test('manual add, inline edits and delete update the cards and totals', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const { app, win } = await launch(userDataDir, buildProjectsFixture())
  await openTimeTracking(win)
  await expect(win.locator('.ix-tt-card')).toHaveCount(2)

  // Add a manual entry without an issue key on Wednesday.
  const wednesday = dayColumn(win, WEDNESDAY)
  await wednesday.locator('.ix-tt__add').click()
  await wednesday.getByPlaceholder('Description (e.g. 1:1 with Marek)').fill('Team sync meeting')
  await wednesday.getByPlaceholder('Time (e.g. 45m)').fill('30m')
  await wednesday.locator('.ix-tt-form__actions .ix-btn--primary', { hasText: 'Save' }).click()

  await expect(wednesday.locator('.ix-tt-card__title')).toHaveText('Team sync meeting')
  await expect(wednesday.locator('.ix-tt-card__key')).toHaveValue('')
  await expect(wednesday.locator('.ix-tt__day-total')).toHaveText('30m')
  await expect(win.locator('.ix-tt__total')).toHaveText('3h 10m total')

  // A nonsense time is rejected with an inline error and no card.
  const thursday = dayColumn(win, weekdayThisWeek(3))
  await thursday.locator('.ix-tt__add').click()
  await thursday.getByPlaceholder('Description (e.g. 1:1 with Marek)').fill('Broken')
  await thursday.getByPlaceholder('Time (e.g. 45m)').fill('lots')
  await thursday.locator('.ix-tt-form__actions .ix-btn--primary', { hasText: 'Save' }).click()
  await expect(thursday.locator('.ix-tt-form__error')).toBeVisible()
  await thursday.locator('.ix-tt-form__actions .ix-btn--ghost', { hasText: 'Cancel' }).click()
  await expect(thursday.locator('.ix-tt-card')).toHaveCount(0)

  // Edit the Monday auto card's duration in place: totals follow.
  const monday = dayColumn(win, MONDAY)
  await monday.locator('.ix-tt-card__dur').fill('2h')
  await monday.locator('.ix-tt-card__dur').press('Enter')
  await expect(monday.locator('.ix-tt__day-total')).toHaveText('2h 0m')
  await expect(win.locator('.ix-tt__total')).toHaveText('3h 25m total')

  // Edit the Tuesday auto card's issue key in place (it had none).
  const tuesday = dayColumn(win, TUESDAY)
  await tuesday.locator('.ix-tt-card__key').fill('fid2507-612')
  await tuesday.locator('.ix-tt-card__key').press('Enter')
  await expect(tuesday.locator('.ix-tt-card__key')).toHaveValue('FID2507-612')

  // An unparsable duration edit reverts to the previous value.
  await monday.locator('.ix-tt-card__dur').fill('garbage')
  await monday.locator('.ix-tt-card__dur').press('Enter')
  await expect(monday.locator('.ix-tt-card__dur')).toHaveValue('2h 0m')

  // Delete the Tuesday auto card (actions appear on hover).
  const tuesdayCard = tuesday.locator('.ix-tt-card')
  await tuesdayCard.hover()
  await tuesdayCard.locator('.ix-iconbtn[title="Delete"]').click()
  await expect(tuesday.locator('.ix-tt-card')).toHaveCount(0)
  await expect(tuesday.locator('.ix-tt__day-total')).toHaveText('—')
  await expect(win.locator('.ix-tt__total')).toHaveText('2h 30m total')

  await app.close()
})

test('week navigation moves the range, empties the board, and Today returns', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const { app, win } = await launch(userDataDir, buildProjectsFixture())
  await openTimeTracking(win)
  await expect(win.locator('.ix-tt-card')).toHaveCount(2)

  const currentRange = await win.locator('.ix-tt__range').textContent()

  await win.locator('.ix-iconbtn[title="Previous week"]').click()
  await expect(win.locator('.ix-tt__range')).not.toHaveText(currentRange!)
  await expect(win.locator('.ix-tt-card')).toHaveCount(0)
  await expect(win.locator('.ix-tt__total')).toHaveText('0m total')
  await expect(win.locator('.ix-tt__day--today')).toHaveCount(0)

  await win.locator('.ix-tt__topbar .ix-btn', { hasText: 'Today' }).click()
  await expect(win.locator('.ix-tt__range')).toHaveText(currentRange!)
  await expect(win.locator('.ix-tt-card')).toHaveCount(2)
  if (RUNS_ON_WEEKDAY) await expect(win.locator('.ix-tt__day--today')).toHaveCount(1)

  await app.close()
})

test('manual entries, auto-card edits and deletions persist across a relaunch', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-e2e-'))
  const projectsDir = buildProjectsFixture()

  const first = await launch(userDataDir, projectsDir)
  await openTimeTracking(first.win)
  await expect(first.win.locator('.ix-tt-card')).toHaveCount(2)

  const wednesday = dayColumn(first.win, WEDNESDAY)
  await wednesday.locator('.ix-tt__add').click()
  await wednesday.getByPlaceholder('Description (e.g. 1:1 with Marek)').fill('1:1 with Marek')
  await wednesday.getByPlaceholder('Issue key (optional)').fill('FID2507-700')
  await wednesday.getByPlaceholder('Time (e.g. 45m)').fill('1h')
  await wednesday.locator('.ix-tt-form__actions .ix-btn--primary', { hasText: 'Save' }).click()
  await expect(wednesday.locator('.ix-tt-card')).toHaveCount(1)

  const monday = dayColumn(first.win, MONDAY)
  await monday.locator('.ix-tt-card__dur').fill('3h')
  await monday.locator('.ix-tt-card__dur').press('Enter')
  await expect(first.win.locator('.ix-tt__total')).toHaveText('4h 55m total')

  const tuesdayCard = dayColumn(first.win, TUESDAY).locator('.ix-tt-card')
  await tuesdayCard.hover()
  await tuesdayCard.locator('.ix-iconbtn[title="Delete"]').click()
  await expect(first.win.locator('.ix-tt__total')).toHaveText('4h 0m total')
  await first.app.close()

  // Same profile and projects dir: the manual card, the edited duration and the deletion survive.
  const second = await launch(userDataDir, projectsDir)
  await openTimeTracking(second.win)
  await expect(dayColumn(second.win, WEDNESDAY).locator('.ix-tt-card__title')).toHaveText(
    '1:1 with Marek'
  )
  await expect(dayColumn(second.win, WEDNESDAY).locator('.ix-tt-card__key')).toHaveValue(
    'FID2507-700'
  )
  await expect(dayColumn(second.win, MONDAY).locator('.ix-tt-card__dur')).toHaveValue('3h 0m')
  await expect(dayColumn(second.win, TUESDAY).locator('.ix-tt-card')).toHaveCount(0)
  await expect(second.win.locator('.ix-tt__total')).toHaveText('4h 0m total')
  await second.app.close()
})
