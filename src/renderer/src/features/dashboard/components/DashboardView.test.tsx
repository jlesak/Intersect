import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ClaudeUsage, PullRequest, TimeEntry, TodoTask, Workspace } from '@common/domain'
import { weekStartOf } from '@common/week'

// The PR-inbox barrel transitively imports monaco, which cannot initialise under jsdom. No zone
// renders an editor, so an inert stand-in is enough to read a PR selector.
vi.mock('monaco-editor', () => ({ editor: {} }))

import { useAttentionStore } from '@renderer/features/attention'
import { usePrInboxStore } from '@renderer/features/prInbox'
import { useTimeTrackingStore } from '@renderer/features/timeTracking'
import { useTodoStore } from '@renderer/features/todo'
import { useUsageStore } from '@renderer/features/usage'
import { useWorkspacesStore } from '@renderer/features/workspaces'
import { useDashboardNavStore } from '../store'
import { DashboardView } from './DashboardView'

const NOW = new Date(2026, 6, 29, 10, 0, 0).getTime()
const TODAY = '2026-07-29'
const YESTERDAY = '2026-07-28'

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  prId: 1,
  repositoryId: 'repo-a',
  repositoryName: 'spot-backend',
  projectId: 'SPOT',
  title: 'Fix the sync',
  authorId: 'u1',
  authorName: 'Jan',
  createdAt: NOW - 3_600_000,
  status: 'active',
  sourceRefName: 'refs/heads/feature',
  targetRefName: 'refs/heads/main',
  sourceCommitId: 'src',
  targetCommitId: 'tgt',
  url: 'https://ado/pr/1',
  role: 'reviewer',
  myVote: null,
  myReviewerId: null,
  reviewers: [],
  newChangesSinceMyReview: false,
  activeThreadCount: 0,
  ...over
})

const task = (id: string, over: Partial<TodoTask> = {}): TodoTask => ({
  id,
  text: `Task ${id}`,
  description: '',
  dueDay: null,
  priority: 4,
  sortOrder: 0,
  doneAt: null,
  ...over
})

const entry = (day: string, durationMs: number): TimeEntry => ({
  id: `e-${day}-${durationMs}`,
  source: 'manual',
  day,
  description: 'work',
  issueKey: null,
  durationMs
})

const workspace = (id: string, name: string): Workspace => ({
  id,
  name,
  folderPath: `/tmp/${id}`,
  layout: 'single',
  activeTabId: null,
  sortOrder: 0,
  projectId: null,
  projectSource: 'auto'
})

const USAGE: ClaudeUsage = {
  fiveHour: { usedPercent: 42, resetsAt: Math.floor(NOW / 1000) + 3_600 },
  sevenDay: { usedPercent: 95, resetsAt: Math.floor(NOW / 1000) + 86_400 },
  capturedAt: NOW - 60_000
}

const prKey = (p: PullRequest): string => `${p.repositoryId}:${p.prId}`

/** Everything the four zones read, in a state where each of them has something to show. */
function seedPopulated(): void {
  const prs = [pr(), pr({ prId: 2, title: 'Rework the importer', createdAt: NOW - 7_200_000 })]
  usePrInboxStore.setState({
    status: 'ready',
    prsByKey: Object.fromEntries(prs.map((p) => [prKey(p), p])),
    order: prs.map(prKey),
    syncedAt: NOW - 600_000
  })
  useTodoStore.setState({
    status: 'ready',
    open: [task('late', { dueDay: YESTERDAY }), task('now', { dueDay: TODAY })],
    done: []
  })
  useAttentionStore.setState({
    status: {
      'ws-1:tab-a': { status: 'waiting', since: NOW - 240_000 },
      'ws-1:tab-b': { status: 'working', since: NOW - 60_000 }
    }
  })
  useWorkspacesStore.setState({ byId: { 'ws-1': workspace('ws-1', 'spot-backend') }, order: ['ws-1'] })
  useTimeTrackingStore.setState({
    status: 'ready',
    weekStart: weekStartOf(NOW),
    entries: [entry(TODAY, 45 * 60_000), entry(YESTERDAY, 60 * 60_000)]
  })
  useUsageStore.setState({ usage: USAGE })
}

/** Every store back to the state a fresh, unconfigured profile boots into. */
function seedEmpty(): void {
  usePrInboxStore.setState({ status: 'idle', prsByKey: {}, order: [], syncedAt: null })
  useTodoStore.setState({ status: 'idle', open: [], done: [] })
  useAttentionStore.setState({ status: {} })
  useWorkspacesStore.setState({ byId: {}, order: [] })
  useTimeTrackingStore.setState({ status: 'idle', weekStart: weekStartOf(NOW), entries: [] })
  useUsageStore.setState({ usage: null })
}

const texts = (selector: string): string[] =>
  [...document.querySelectorAll(selector)].map((e) => e.textContent?.trim() ?? '')

const text = (selector: string): string =>
  document.querySelector(selector)?.textContent?.trim() ?? ''

/**
 * Mount the view and fail on anything the store factory logged. The Dashboard is the app's landing
 * view, so a selector returning a fresh reference here is not a warning - it throws on boot, and
 * this spy is what makes that visible in CI.
 */
async function mountClean(): Promise<void> {
  const logged: string[] = []
  const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
  })
  try {
    await act(async () => {
      render(<DashboardView />)
    })
    expect(logged).toEqual([])
  } finally {
    consoleError.mockRestore()
  }
}

describe('DashboardView', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    useDashboardNavStore.setState({ pendingPrOpen: null, pendingSessionGo: null })
    seedEmpty()
  })

  afterEach(() => {
    vi.useRealTimers()
    seedEmpty()
    useTimeTrackingStore.setState({ timer: null })
  })

  test('a fresh profile with nothing configured mounts clean and still shows all four zones', async () => {
    await mountClean()

    expect(texts('.ix-dash-zone__title')).toEqual([
      'Needs action',
      'Running sessions',
      'Time today',
      'System status'
    ])
    // Every zone keeps its heading and shrinks to a one-line state rather than disappearing.
    expect(document.querySelectorAll('.ix-dash-zone')).toHaveLength(4)
    expect(document.querySelectorAll('.ix-dash-row')).toHaveLength(0)
  })

  test('the zones keep their fixed order once every one of them has content', async () => {
    seedPopulated()
    await mountClean()
    expect(texts('.ix-dash-zone__title')).toEqual([
      'Needs action',
      'Running sessions',
      'Time today',
      'System status'
    ])
  })

  test('needs action lists the PRs oldest first, then the deadlines late first', async () => {
    seedPopulated()
    await mountClean()

    expect(texts('.ix-dash-group__label')).toEqual(['Pull requests', 'Deadlines'])
    expect(texts('.ix-dash-group__count')).toEqual(['2', '2'])
    // The longest-blocked review is the most urgent, so it leads.
    expect(texts('.ix-dash-row__title')).toEqual([
      'Rework the importer',
      'Fix the sync',
      'Task late',
      'Task now'
    ])
    expect(texts('.ix-dash-row__due')).toEqual(['yesterday', 'today'])
    expect(document.querySelectorAll('.ix-dash-row__due--overdue')).toHaveLength(1)
  })

  test('an empty needs-action zone keeps both subgroups and says so', async () => {
    await mountClean()
    expect(texts('.ix-dash-group__label')).toEqual(['Pull requests', 'Deadlines'])
    expect(texts('.ix-dash-group__empty')).toEqual([
      'No pull request is waiting on you.',
      'Nothing is due today.'
    ])
  })

  test('clicking a PR row records where to go, and never navigates by itself', async () => {
    seedPopulated()
    await mountClean()

    await act(async () => {
      document.querySelectorAll<HTMLButtonElement>('.ix-dash-row')[0].click()
    })
    // The oldest action PR is #2; the app layer is what turns this into a section switch.
    expect(useDashboardNavStore.getState().pendingPrOpen).toEqual({
      repositoryId: 'repo-a',
      prId: 2
    })
  })

  test('clicking a deadline asks the TODO list to reveal that task', async () => {
    seedPopulated()
    await mountClean()

    await act(async () => {
      document.querySelector<HTMLButtonElement>('.ix-dash-row--todo')?.click()
    })
    expect(useTodoStore.getState().pendingFocusId).toBe('late')
  })

  test('running sessions lead with the one waiting longest and offer a way in', async () => {
    seedPopulated()
    await mountClean()

    expect(texts('.ix-dash-session__name')).toEqual(['spot-backend', 'spot-backend'])
    expect(texts('.ix-dash-session__state')[0]).toContain('waiting for you')
    // Only a session that has something for the user is worth a jump; working needs nothing.
    expect(document.querySelectorAll('.ix-dash-session__go')).toHaveLength(1)

    await act(async () => {
      document.querySelector<HTMLButtonElement>('.ix-dash-session__go')?.click()
    })
    expect(useDashboardNavStore.getState().pendingSessionGo).toBe('ws-1:tab-a')
  })

  test('a session with no attention state is not a running session', async () => {
    await mountClean()
    expect(document.querySelectorAll('.ix-dash-session')).toHaveLength(0)
    expect(text('.ix-dash-sessions__empty')).toBe('No Claude session is asking for anything.')
  })

  test('time today shows the total logged and the timer control', async () => {
    seedPopulated()
    await mountClean()
    expect(text('.ix-dash-time__total')).toBe('45m')
    expect(text('.ix-timer__action')).toBe('Start')
  })

  test('a week other than this one offers a way back instead of a wrong number', async () => {
    seedPopulated()
    useTimeTrackingStore.setState({ weekStart: '2026-03-02' })
    await mountClean()

    expect(document.querySelector('.ix-dash-time__total')).toBeNull()
    expect(text('.ix-dash-time__note')).toContain('another week')
    expect(text('.ix-dash-time__week')).toBe('Show this week')
  })

  test('a weekend says the board does not track it rather than showing 0m', async () => {
    seedPopulated()
    const saturday = new Date(2026, 7, 1, 10, 0, 0).getTime()
    vi.setSystemTime(saturday)
    useTimeTrackingStore.setState({ weekStart: weekStartOf(saturday) })
    await mountClean()

    expect(document.querySelector('.ix-dash-time__total')).toBeNull()
    expect(text('.ix-dash-time__note')).toContain('weekend')
    // The timer still works on a weekend; only the day total is meaningless.
    expect(text('.ix-timer__action')).toBe('Start')
  })

  test('system status shows both usage meters and how fresh each source is', async () => {
    seedPopulated()
    await mountClean()

    expect(texts('.ix-dash-meter__label')).toEqual(['5h session', 'Weekly'])
    expect(texts('.ix-dash-meter__pct')).toEqual(['42%', '95%'])
    expect(texts('.ix-dash-sync__label')).toEqual(['Jira', 'Pull requests'])
    expect(texts('.ix-dash-sync__value')).toEqual(['never', '10m ago'])
  })

  test('system status says what is missing rather than reading as broken', async () => {
    await mountClean()
    expect(document.querySelectorAll('.ix-dash-meter')).toHaveLength(0)
    expect(text('.ix-dash-usage__empty')).toContain('Claude session')
    expect(texts('.ix-dash-sync__value')).toEqual(['never', 'never'])
  })

  test('the ages keep up with the clock without a remount', async () => {
    seedPopulated()
    await mountClean()
    expect(texts('.ix-dash-sync__value')[1]).toBe('10m ago')

    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000)
    })
    expect(texts('.ix-dash-sync__value')[1]).toBe('15m ago')
  })

  test('the worklog is loaded on arrival, since nothing else hydrates it', async () => {
    // Every other source is hydrated at boot; this one is not, and the Dashboard is the first thing
    // the user sees. The call fails without a preload bridge, which is the store's business.
    const hydrate = vi.spyOn(useTimeTrackingStore.getState(), 'hydrate').mockResolvedValue()
    try {
      await mountClean()
      expect(hydrate).toHaveBeenCalledTimes(1)
    } finally {
      hydrate.mockRestore()
    }
  })

  test('an already loaded worklog is not reloaded on every visit', async () => {
    seedPopulated()
    const hydrate = vi.spyOn(useTimeTrackingStore.getState(), 'hydrate').mockResolvedValue()
    try {
      await mountClean()
      expect(hydrate).not.toHaveBeenCalled()
    } finally {
      hydrate.mockRestore()
    }
  })
})
