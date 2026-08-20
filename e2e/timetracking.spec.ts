import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ElectronApplication, type Locator, type Page } from '@playwright/test'
import {
  expect,
  launch,
  openRailSection,
  RAIL_LABELS,
  tempDir,
  test,
  userDataDir
} from './harness'

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

/** An ISO timestamp at a local time of day on the given day key; minute overflow rolls the hour. */
function isoAt(day: string, hour: number, minute = 0): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, hour, minute).toISOString()
}

// The fixture's four sessions, placed relative to the current week at test runtime: two Monday
// cards, one Tuesday card, plus a Saturday session that must never appear.
const MONDAY = weekdayThisWeek(0)
const TUESDAY = weekdayThisWeek(1)
const WEDNESDAY = weekdayThisWeek(2)
const SATURDAY = weekdayThisWeek(5)

/**
 * A session's active time is the sum of the gaps between its consecutive timestamped records, each
 * gap capped at ten minutes of idle. The fixture therefore states each session as its list of gaps,
 * and every expected card duration and day total below is the arithmetic on these lists:
 *
 * - Monday, `Lock owner on the card`: 8+9+7+9+8+9+6+7 = 63m, so `1h 3m`.
 * - Monday, `Rail spacing pass`: 5+7 = 12m, so `12m`.
 *   Monday's column total is therefore 1h 15m - a figure no single card carries, which is what
 *   makes the day total a real assertion about grouping rather than an echo of one card.
 * - Tuesday, `Board scaffolding`: a single 60m gap, clamped by the idle cap to `10m`. This is the
 *   one session that pins the cap; every other gap stays under ten minutes on purpose.
 * - The whole board: 63 + 12 + 10 = 85m, so `1h 25m total`.
 */
const MONDAY_LONG_GAPS = [8, 9, 7, 9, 8, 9, 6, 7]
const MONDAY_SHORT_GAPS = [5, 7]
const TUESDAY_IDLE_GAPS = [60]

/**
 * A fixture `~/.claude/projects`-shaped tree with sessions at known weekdays/durations/branches of
 * the current week, so the board has deterministic auto entries without touching real user data.
 */
function buildProjectsFixture(): string {
  const projectsDir = tempDir('intersect-tt-')
  const write = (folder: string, id: string, lines: object[]): void => {
    const dir = join(projectsDir, folder)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
  }

  /**
   * One session file: an untimestamped title record, then alternating user/assistant records placed
   * at the running sum of `gapMinutes` after `startHour`. Several records per session is what lets
   * the fixture dictate an exact active time - two records alone can only ever express one gap.
   */
  const session = (
    title: string,
    day: string,
    startHour: number,
    gapMinutes: number[],
    gitBranch: string
  ): object[] => {
    const records: object[] = [
      { type: 'ai-title', aiTitle: title },
      {
        type: 'user',
        message: { role: 'user', content: 'do the work' },
        timestamp: isoAt(day, startHour),
        cwd: '/tmp/proj',
        gitBranch,
        isMeta: false
      }
    ]
    let minute = 0
    gapMinutes.forEach((gap, i) => {
      minute += gap
      const timestamp = isoAt(day, startHour, minute)
      records.push(
        i % 2 === 0
          ? {
              type: 'assistant',
              message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
              timestamp,
              cwd: '/tmp/proj'
            }
          : {
              type: 'user',
              message: { role: 'user', content: 'keep going' },
              timestamp,
              cwd: '/tmp/proj',
              isMeta: false
            }
      )
    })
    return records
  }

  write(
    'proj-a',
    'aaaaaaaa-1111-2222-3333-444444444444',
    session(
      'Lock owner on the card',
      MONDAY,
      9,
      MONDAY_LONG_GAPS,
      'feature/fid2507-611-lock-owner'
    )
  )
  write(
    'proj-a',
    'dddddddd-1111-2222-3333-444444444444',
    session('Rail spacing pass', MONDAY, 14, MONDAY_SHORT_GAPS, 'feature/fid2507-650-rail-spacing')
  )
  write(
    'proj-a',
    'bbbbbbbb-5555-6666-7777-888888888888',
    session('Board scaffolding', TUESDAY, 13, TUESDAY_IDLE_GAPS, 'feature/time-tracking')
  )
  write(
    'proj-b',
    'cccccccc-9999-aaaa-bbbb-cccccccccccc',
    session('Weekend experiment', SATURDAY, 10, [9, 9], 'feature/fid2507-999-weekend')
  )

  return projectsDir
}

/** Boot the app against the fixture tree; the harness default would show an empty projects dir. */
async function launchWithFixture(
  profileDir: string,
  projectsDir: string
): Promise<{ app: ElectronApplication; win: Page }> {
  return launch(profileDir, { env: { INTERSECT_CLAUDE_PROJECTS_DIR: projectsDir } })
}

async function openTimeTracking(win: Page): Promise<void> {
  await openRailSection(win, 'Time Tracking', '.ix-tt__board')
}

const dayColumn = (win: Page, day: string): Locator => win.locator(`.ix-tt__day[data-day="${day}"]`)

// The timer is mounted on several surfaces at once (the section topbar, the Dashboard zone, and
// the app shell while one runs), so every locator here names the surface it means.
const topbarTimer = (win: Page): Locator => win.locator('.ix-tt__topbar .ix-timer__action')
const topbarElapsed = (win: Page): Locator => win.locator('.ix-tt__topbar .ix-timer__elapsed')
const shellTimer = (win: Page): Locator => win.locator('.ix-sidebar__timer')

/** A day's nth card, needed wherever a column holds more than one. */
const cardAt = (column: Locator, index: number): Locator =>
  column.locator('.ix-tt-card').nth(index)

// The TODAY badge only exists when the suite runs on a weekday; a weekend run shows the current
// week without a highlighted column.
const RUNS_ON_WEEKDAY = ![0, 6].includes(new Date().getDay())

test('the rail lists every section and the board shows the week with auto cards in their days', async () => {
  const { win } = await launchWithFixture(userDataDir(), buildProjectsFixture())

  await expect(win.locator('.ix-rail__label')).toHaveText([...RAIL_LABELS])

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

  // Monday's two session cards, chronological: derived issue key, title and summed active time.
  const monday = dayColumn(win, MONDAY)
  await expect(monday.locator('.ix-tt-card')).toHaveCount(2)
  await expect(cardAt(monday, 0).locator('.ix-tt-card__key')).toHaveValue('FID2507-611')
  await expect(cardAt(monday, 0).locator('.ix-tt-card__title')).toHaveValue('Lock owner on the card')
  await expect(cardAt(monday, 0).locator('.ix-tt-card__dur')).toHaveValue('1h 3m')
  await expect(cardAt(monday, 1).locator('.ix-tt-card__key')).toHaveValue('FID2507-650')
  await expect(cardAt(monday, 1).locator('.ix-tt-card__title')).toHaveValue('Rail spacing pass')
  await expect(cardAt(monday, 1).locator('.ix-tt-card__dur')).toHaveValue('12m')

  // The day total is the sum of both cards, so it matches neither on its own.
  await expect(monday.locator('.ix-tt__day-total')).toHaveText('1h 15m')

  // The Tuesday session has no key in its branch: empty editable key showing "no issue". Its single
  // hour-long gap is idle time, so the ten-minute cap is what the card reports.
  const tuesday = dayColumn(win, TUESDAY)
  await expect(tuesday.locator('.ix-tt-card__key')).toHaveValue('')
  await expect(tuesday.locator('.ix-tt-card__key')).toHaveAttribute('placeholder', 'no issue')
  await expect(tuesday.locator('.ix-tt-card__dur')).toHaveValue('10m')
  await expect(tuesday.locator('.ix-tt__day-total')).toHaveText('10m')

  // The Saturday session is excluded entirely: three cards on the whole board, weekend not counted.
  await expect(win.locator('.ix-tt-card')).toHaveCount(3)
  await expect(win.locator('.ix-tt__total')).toHaveText('1h 25m total')
})

test('manual add, inline edits and delete update the cards and totals', async () => {
  const { win } = await launchWithFixture(userDataDir(), buildProjectsFixture())
  await openTimeTracking(win)
  await expect(win.locator('.ix-tt-card')).toHaveCount(3)

  // Add a manual entry without an issue key on Wednesday: 85m + 30m = 1h 55m.
  const wednesday = dayColumn(win, WEDNESDAY)
  await wednesday.locator('.ix-tt__add').click()
  await wednesday.getByPlaceholder('Description (e.g. 1:1 with Marek)').fill('Team sync meeting')
  await wednesday.getByPlaceholder('Time (e.g. 45m)').fill('30m')
  await wednesday.locator('.ix-tt-form__actions .ix-btn--primary', { hasText: 'Save' }).click()

  await expect(wednesday.locator('.ix-tt-card__title')).toHaveValue('Team sync meeting')
  await expect(wednesday.locator('.ix-tt-card__key')).toHaveValue('')
  await expect(wednesday.locator('.ix-tt__day-total')).toHaveText('30m')
  await expect(win.locator('.ix-tt__total')).toHaveText('1h 55m total')

  // A nonsense time is rejected with an inline error and no card.
  const thursday = dayColumn(win, weekdayThisWeek(3))
  await thursday.locator('.ix-tt__add').click()
  await thursday.getByPlaceholder('Description (e.g. 1:1 with Marek)').fill('Broken')
  await thursday.getByPlaceholder('Time (e.g. 45m)').fill('lots')
  await thursday.locator('.ix-tt-form__actions .ix-btn--primary', { hasText: 'Save' }).click()
  await expect(thursday.locator('.ix-tt-form__error')).toBeVisible()
  await thursday.locator('.ix-tt-form__actions .ix-btn--ghost', { hasText: 'Cancel' }).click()
  await expect(thursday.locator('.ix-tt-card')).toHaveCount(0)

  // Edit the first Monday auto card's duration in place: 1h 3m becomes 2h, so Monday's total moves
  // to 2h + 12m and the week's to 2h 12m + 10m + 30m.
  const monday = dayColumn(win, MONDAY)
  const mondayFirstDur = cardAt(monday, 0).locator('.ix-tt-card__dur')
  await mondayFirstDur.fill('2h')
  await mondayFirstDur.press('Enter')
  await expect(monday.locator('.ix-tt__day-total')).toHaveText('2h 12m')
  await expect(win.locator('.ix-tt__total')).toHaveText('2h 52m total')

  // Edit the Tuesday auto card's issue key in place (it had none).
  const tuesday = dayColumn(win, TUESDAY)
  await tuesday.locator('.ix-tt-card__key').fill('fid2507-612')
  await tuesday.locator('.ix-tt-card__key').press('Enter')
  await expect(tuesday.locator('.ix-tt-card__key')).toHaveValue('FID2507-612')

  // An unparsable duration edit reverts to the previous value.
  await mondayFirstDur.fill('garbage')
  await mondayFirstDur.press('Enter')
  await expect(mondayFirstDur).toHaveValue('2h 0m')

  // Delete the Tuesday auto card (actions appear on hover): the week loses its 10m.
  const tuesdayCard = tuesday.locator('.ix-tt-card')
  await tuesdayCard.hover()
  await tuesdayCard.locator('.ix-iconbtn[title="Delete"]').click()
  await expect(tuesday.locator('.ix-tt-card')).toHaveCount(0)
  await expect(tuesday.locator('.ix-tt__day-total')).toHaveText('—')
  await expect(win.locator('.ix-tt__total')).toHaveText('2h 42m total')
})

test('week navigation moves the range, empties the board, and Today returns', async () => {
  const { win } = await launchWithFixture(userDataDir(), buildProjectsFixture())
  await openTimeTracking(win)
  await expect(win.locator('.ix-tt-card')).toHaveCount(3)

  const currentRange = await win.locator('.ix-tt__range').textContent()

  await win.locator('.ix-iconbtn[title="Previous week"]').click()
  await expect(win.locator('.ix-tt__range')).not.toHaveText(currentRange!)
  await expect(win.locator('.ix-tt-card')).toHaveCount(0)
  await expect(win.locator('.ix-tt__total')).toHaveText('0m total')
  await expect(win.locator('.ix-tt__day--today')).toHaveCount(0)

  await win.locator('.ix-tt__topbar .ix-btn', { hasText: 'Today' }).click()
  await expect(win.locator('.ix-tt__range')).toHaveText(currentRange!)
  await expect(win.locator('.ix-tt-card')).toHaveCount(3)
  if (RUNS_ON_WEEKDAY) await expect(win.locator('.ix-tt__day--today')).toHaveCount(1)
})

test('manual entries, auto-card edits and deletions persist across a relaunch', async () => {
  const profileDir = userDataDir()
  const projectsDir = buildProjectsFixture()

  const first = await launchWithFixture(profileDir, projectsDir)
  await openTimeTracking(first.win)
  await expect(first.win.locator('.ix-tt-card')).toHaveCount(3)

  const wednesday = dayColumn(first.win, WEDNESDAY)
  await wednesday.locator('.ix-tt__add').click()
  await wednesday.getByPlaceholder('Description (e.g. 1:1 with Marek)').fill('1:1 with Marek')
  await wednesday.getByPlaceholder('Issue key (optional)').fill('FID2507-700')
  await wednesday.getByPlaceholder('Time (e.g. 45m)').fill('1h')
  await wednesday.locator('.ix-tt-form__actions .ix-btn--primary', { hasText: 'Save' }).click()
  await expect(wednesday.locator('.ix-tt-card')).toHaveCount(1)

  // 3h + 12m Monday, 10m Tuesday, 1h Wednesday = 4h 22m.
  const monday = dayColumn(first.win, MONDAY)
  const mondayFirstDur = cardAt(monday, 0).locator('.ix-tt-card__dur')
  await mondayFirstDur.fill('3h')
  await mondayFirstDur.press('Enter')
  await expect(first.win.locator('.ix-tt__total')).toHaveText('4h 22m total')

  const tuesdayCard = dayColumn(first.win, TUESDAY).locator('.ix-tt-card')
  await tuesdayCard.hover()
  await tuesdayCard.locator('.ix-iconbtn[title="Delete"]').click()
  await expect(first.win.locator('.ix-tt__total')).toHaveText('4h 12m total')
  await first.app.close()

  // Same profile and projects dir: the manual card, the edited duration and the deletion survive.
  const second = await launchWithFixture(profileDir, projectsDir)
  await openTimeTracking(second.win)
  await expect(dayColumn(second.win, WEDNESDAY).locator('.ix-tt-card__title')).toHaveValue(
    '1:1 with Marek'
  )
  await expect(dayColumn(second.win, WEDNESDAY).locator('.ix-tt-card__key')).toHaveValue(
    'FID2507-700'
  )
  await expect(
    cardAt(dayColumn(second.win, MONDAY), 0).locator('.ix-tt-card__dur')
  ).toHaveValue('3h 0m')
  await expect(cardAt(dayColumn(second.win, MONDAY), 1).locator('.ix-tt-card__dur')).toHaveValue(
    '12m'
  )
  await expect(dayColumn(second.win, TUESDAY).locator('.ix-tt-card')).toHaveCount(0)
  await expect(second.win.locator('.ix-tt__total')).toHaveText('4h 12m total')
})

test('the work timer keeps running across a relaunch and logs an entry on stop', async () => {
  // One profile, two launches, no session fixture: the only card the board can end up with is the
  // one the timer wrote. The harness gives each launch its own empty projects dir by default.
  const profileDir = userDataDir()

  const first = await launch(profileDir)
  await openTimeTracking(first.win)

  // Nothing has been started, so the control offers exactly one action, and the shell carries no
  // chip at all.
  await expect(topbarTimer(first.win)).toHaveText('Start')
  await expect(shellTimer(first.win)).toHaveCount(0)
  await topbarTimer(first.win).click()
  await expect(topbarTimer(first.win)).toHaveText('Stop')
  await expect(topbarElapsed(first.win)).toBeVisible()
  await first.app.close()

  // The timer is durable state, not renderer state: it is still running after a full restart.
  const second = await launch(profileDir)
  await openTimeTracking(second.win)
  await expect(topbarTimer(second.win)).toHaveText('Stop')

  // A start-then-stop under a second is treated as a misclick and discarded, and a relaunch takes
  // well under that, so the span has to be given time to cross the floor deliberately. Waiting on
  // the ticking figure to reach two seconds is the wait itself: it measures elapsed time from the
  // durable start, so past this point the stop below is guaranteed to reach the logging path.
  await expect(topbarElapsed(second.win)).toHaveText(
    /^(0:0[2-9]|0:[1-5]\d|[1-9]\d*:\d\d(:\d\d)?)$/
  )

  // The shell chip is the whole point of a running timer being visible outside its own section:
  // it counts alongside the topbar and offers the same Stop.
  await expect(shellTimer(second.win).locator('.ix-timer__action')).toHaveText('Stop')

  await topbarTimer(second.win).click()
  await expect(topbarTimer(second.win)).toHaveText('Start')
  await expect(shellTimer(second.win)).toHaveCount(0)

  // Stopping logged the span as an ordinary card on today's column, editable like any other. It
  // was started without a description, so it carries the neutral fallback label. The board only
  // has weekday columns, so a weekend run has nowhere to show it.
  if (RUNS_ON_WEEKDAY) {
    const today = dayColumn(second.win, dayKey(new Date()))
    await expect(today.locator('.ix-tt-card')).toHaveCount(1)
    await expect(today.locator('.ix-tt-card__title')).toHaveValue('Timed work')
  }
})

test('the weekly summary rolls the board up two ways and copies the week for a timesheet', async () => {
  const { app, win } = await launchWithFixture(userDataDir(), buildProjectsFixture())
  await openTimeTracking(win)

  // Collapsed at first so the board keeps its full height, with the export reachable either way.
  const summary = win.locator('.ix-tt-summary')
  await expect(summary.locator('.ix-tt-summary__body')).toHaveCount(0)
  await expect(summary.locator('.ix-tt-summary__count')).toHaveText('2 issues · 0 projects')

  await summary.locator('.ix-tt-summary__toggle').click()

  // Per issue: the same figures the cards carry, heaviest first, with the unattributed Tuesday
  // session in its own named bucket rather than dropped.
  const byIssue = summary.locator('[data-rollup="By issue"]')
  await expect(byIssue.locator('.ix-tt-summary__label')).toHaveText([
    'FID2507-611',
    'FID2507-650',
    'No issue'
  ])
  await expect(byIssue.locator('.ix-tt-summary__total')).toHaveText(['1h 3m', '12m', '10m'])

  // No project is bound in this profile, so every card is unclaimed and the single bucket has to
  // equal the weekly grand total in the topbar. That agreement is the panel's own self-check.
  const byProject = summary.locator('[data-rollup="By project"]')
  await expect(byProject.locator('.ix-tt-summary__label')).toHaveText(['Other'])
  await expect(byProject.locator('.ix-tt-summary__total')).toHaveText(['1h 25m'])
  await expect(win.locator('.ix-tt__total')).toHaveText('1h 25m total')

  // Copying writes the real system clipboard, so whatever the developer had in it is put back
  // afterwards. Durations are decimal hours here: a timesheet column has to add up.
  const before = await app.evaluate(({ clipboard }) => clipboard.readText())
  await summary.getByRole('button', { name: 'Copy CSV' }).click()
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe(
      [
        'Date,Issue,Description,Duration',
        `${MONDAY},FID2507-611,Lock owner on the card,1.05`,
        `${MONDAY},FID2507-650,Rail spacing pass,0.20`,
        `${TUESDAY},,Board scaffolding,0.17`
      ].join('\n')
    )
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), before)
})
