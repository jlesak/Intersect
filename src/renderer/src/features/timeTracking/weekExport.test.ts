import { describe, expect, test } from 'vitest'
import type { TimeEntry } from '@common/domain'
import { weekAsCsv, weekAsText } from './weekExport'

const MIN = 60_000

const entry = (over: Partial<TimeEntry> = {}): TimeEntry => ({
  id: 'e1',
  source: 'manual',
  ...{ sessionId: 's1', sessionTitle: 'Session', cwd: '/work', folderName: 'work', gitBranch: null, firstTimestamp: 1, lastTimestamp: 2 },
  day: '2026-08-17',
  description: 'Refactor validators',
  issueKey: 'PROJ-611',
  durationMs: 90 * MIN,
  ...over
})

/** The board's own order: day by day, in the order main returned them. */
const WEEK: TimeEntry[] = [
  entry({ id: 'a' }),
  entry({ id: 'b', description: 'Sprint review', issueKey: null, durationMs: 30 * MIN }),
  entry({
    id: 'c',
    day: '2026-08-18',
    description: 'Pair on the migration',
    issueKey: 'PROJ-900',
    durationMs: 45 * MIN
  })
]

describe('weekAsText', () => {
  test('is a header, one tab-separated line per entry, and a final total', () => {
    expect(weekAsText(WEEK)).toBe(
      [
        'Date\tIssue\tDescription\tDuration',
        '2026-08-17\tPROJ-611\tRefactor validators\t1h 30m',
        '2026-08-17\t\tSprint review\t30m',
        '2026-08-18\tPROJ-900\tPair on the migration\t45m',
        'Total\t\t\t2h 45m'
      ].join('\n')
    )
  })

  test('a week with nothing logged still pastes as a readable week', () => {
    expect(weekAsText([])).toBe('Date\tIssue\tDescription\tDuration\nTotal\t\t\t0m')
  })

  test('a tab or a newline inside a description cannot break the column layout', () => {
    const text = weekAsText([entry({ description: 'Review\tof the\nspec' })])
    expect(text.split('\n')[1]).toBe('2026-08-17\tPROJ-611\tReview of the spec\t1h 30m')
  })
})

describe('weekAsCsv', () => {
  test('is a header row and one row per entry, with duration as decimal hours', () => {
    expect(weekAsCsv(WEEK)).toBe(
      [
        'Date,Issue,Description,Duration',
        '2026-08-17,PROJ-611,Refactor validators,1.50',
        '2026-08-17,,Sprint review,0.50',
        '2026-08-18,PROJ-900,Pair on the migration,0.75'
      ].join('\n')
    )
  })

  test('a week with nothing logged is the header alone, so an import reads zero rows', () => {
    expect(weekAsCsv([])).toBe('Date,Issue,Description,Duration')
  })

  test('a comma, a quote or a newline in a field is quoted rather than shifting the columns', () => {
    const csv = weekAsCsv([
      entry({ description: 'Review, then "ship"\nand write it up', issueKey: null })
    ])
    expect(csv.split('\n').slice(1).join('\n')).toBe(
      '2026-08-17,,"Review, then ""ship""\nand write it up",1.50'
    )
  })
})


test('two days of one session export as separate work rows without session metadata', () => {
  const base = entry({ source: 'auto', sessionId: 'shared', sessionTitle: 'Metadata only',
    cwd: '/private/synthetic', folderName: 'synthetic', gitBranch: 'feature/XYZ-1',
    firstTimestamp: 1, lastTimestamp: 2, description: 'Work description', durationMs: 300000 })
  const rows = [{ ...base, id: 'shared:2026-08-17', day: '2026-08-17' },
    { ...base, id: 'shared:2026-08-18', day: '2026-08-18', durationMs: 600000 }]
  expect(weekAsText(rows)).toBe('Date\tIssue\tDescription\tDuration\n2026-08-17\tPROJ-611\tWork description\t5m\n2026-08-18\tPROJ-611\tWork description\t10m\nTotal\t\t\t15m')
  expect(weekAsCsv(rows).split('\n')).toHaveLength(3)
  expect(weekAsCsv(rows)).not.toContain('Metadata only')
  expect(weekAsCsv(rows)).not.toContain('/private/synthetic')
})
