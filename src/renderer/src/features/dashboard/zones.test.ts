import { describe, expect, test } from 'vitest'
import type { PullRequest, TimeEntry, TodoTask } from '@common/domain'
import { actionPrs, deadlineTodos, isWeekend, loggedToday } from './zones'

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  prId: 1,
  repositoryId: 'repo-a',
  repositoryName: 'spot-backend',
  projectId: 'SPOT',
  title: 'a change',
  authorId: 'u1',
  authorName: 'Jan',
  createdAt: 1_000,
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

// A Wednesday, its Monday, and the two weekend days around it - local time throughout, as the
// board's day keys are.
const WEDNESDAY = new Date(2026, 6, 29, 10, 0, 0).getTime()
const WEEK_START = '2026-07-27'

describe('actionPrs', () => {
  test('keeps only the PRs that need my action', () => {
    const needsMyVote = pr({ prId: 1, role: 'reviewer', myVote: null })
    const alreadyVoted = pr({ prId: 2, role: 'reviewer', myVote: 'approved' })
    expect(actionPrs([needsMyVote, alreadyVoted]).map((a) => a.pr.prId)).toEqual([1])
  })

  test('the longest-blocked PR comes first', () => {
    const list = actionPrs([
      pr({ prId: 1, createdAt: 3_000 }),
      pr({ prId: 2, createdAt: 1_000 }),
      pr({ prId: 3, createdAt: 2_000 })
    ])
    expect(list.map((a) => a.pr.prId)).toEqual([2, 3, 1])
  })

  test('each row carries why it needs me', () => {
    const [row] = actionPrs([pr({ role: 'reviewer', myVote: null })])
    expect(row.reason).toBe('no vote yet')
  })

  test('an author is on the hook for unresolved comments', () => {
    const list = actionPrs([pr({ role: 'author', activeThreadCount: 2 })])
    expect(list.map((a) => a.reason)).toEqual(['2 unresolved comments'])
  })

  test('nothing needing action is an empty list, not an empty-ish one', () => {
    expect(actionPrs([])).toEqual([])
    expect(actionPrs([pr({ role: 'reviewer', myVote: 'approved' })])).toEqual([])
  })
})

describe('deadlineTodos', () => {
  const TODAY = '2026-07-29'

  test('overdue tasks come before tasks due today', () => {
    const list = deadlineTodos(
      [task('today', { dueDay: TODAY }), task('late', { dueDay: '2026-07-28' })],
      TODAY
    )
    expect(list.map((d) => d.task.id)).toEqual(['late', 'today'])
    expect(list.map((d) => d.overdue)).toEqual([true, false])
  })

  test('within a group the earliest due day comes first', () => {
    const list = deadlineTodos(
      [
        task('a', { dueDay: '2026-07-28' }),
        task('b', { dueDay: '2026-07-01' }),
        task('c', { dueDay: '2026-07-15' })
      ],
      TODAY
    )
    expect(list.map((d) => d.task.id)).toEqual(['b', 'c', 'a'])
  })

  test('a task due later is not a deadline yet', () => {
    expect(deadlineTodos([task('a', { dueDay: '2026-07-30' })], TODAY)).toEqual([])
  })

  test('a task with no due day is never a deadline', () => {
    expect(deadlineTodos([task('a', { dueDay: null })], TODAY)).toEqual([])
  })

  test('a task already ticked off is not a deadline however late it was', () => {
    expect(deadlineTodos([task('a', { dueDay: '2026-01-01', doneAt: 5 })], TODAY)).toEqual([])
  })

  test('due today is due, and not yet late', () => {
    const [row] = deadlineTodos([task('a', { dueDay: TODAY })], TODAY)
    expect(row.overdue).toBe(false)
  })
})

describe('loggedToday', () => {
  test('sums only what was logged today', () => {
    const entries = [
      entry('2026-07-29', 30 * 60_000),
      entry('2026-07-29', 15 * 60_000),
      entry('2026-07-28', 60 * 60_000)
    ]
    expect(loggedToday(entries, WEEK_START, WEDNESDAY)).toBe(45 * 60_000)
  })

  test('a day with nothing logged is zero, which is a real answer', () => {
    expect(loggedToday([entry('2026-07-28', 60 * 60_000)], WEEK_START, WEDNESDAY)).toBe(0)
    expect(loggedToday([], WEEK_START, WEDNESDAY)).toBe(0)
  })

  test('a loaded week other than this one has no answer at all, rather than zero', () => {
    // The store holds exactly one week. Reporting 0 for "you navigated to March" would be a wrong
    // number where the honest answer is that this week's figure is simply not loaded.
    expect(loggedToday([], '2026-03-02', WEDNESDAY)).toBeNull()
    expect(loggedToday([entry('2026-07-29', 60_000)], '2026-03-02', WEDNESDAY)).toBeNull()
  })
})

describe('isWeekend', () => {
  test('Saturday and Sunday fall outside the board', () => {
    expect(isWeekend(new Date(2026, 7, 1, 12).getTime())).toBe(true)
    expect(isWeekend(new Date(2026, 7, 2, 12).getTime())).toBe(true)
  })

  test('every weekday is on the board', () => {
    for (const day of [27, 28, 29, 30, 31]) {
      expect(isWeekend(new Date(2026, 6, day, 12).getTime())).toBe(false)
    }
  })
})
