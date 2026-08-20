import { describe, expect, test } from 'vitest'
import type { Project, ProjectOverride, TimeEntry } from '@common/domain'
import { totalMs } from './time'
import { NO_ISSUE_KEY, OTHER_PROJECT_KEY, rollupByIssue, rollupByProject } from './rollup'

const MIN = 60_000

const entry = (over: Partial<TimeEntry> = {}): TimeEntry => ({
  id: Math.random().toString(36).slice(2),
  source: 'manual',
  day: '2026-08-17',
  description: 'Work',
  issueKey: null,
  durationMs: 30 * MIN,
  ...over
})

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'Fabia',
  sortOrder: 0,
  archived: false,
  repoPaths: ['/repo'],
  jiraJql: 'project = FID2507',
  jiraBoardUrl: null,
  adoRepositories: [],
  ...over
})

describe('rollupByIssue', () => {
  test('sums each issue and orders the heaviest first', () => {
    const rows = rollupByIssue([
      entry({ issueKey: 'FID2507-611', durationMs: 30 * MIN }),
      entry({ issueKey: 'FID2507-900', durationMs: 90 * MIN }),
      entry({ issueKey: 'FID2507-611', durationMs: 15 * MIN })
    ])
    expect(rows.map((r) => [r.label, r.totalMs, r.entries])).toEqual([
      ['FID2507-900', 90 * MIN, 1],
      ['FID2507-611', 45 * MIN, 2]
    ])
  })

  test('unattributed time lands in a named bucket that is always last', () => {
    const rows = rollupByIssue([
      entry({ issueKey: null, durationMs: 120 * MIN }),
      entry({ issueKey: 'FID2507-611', durationMs: 10 * MIN })
    ])
    expect(rows.map((r) => r.key)).toEqual(['FID2507-611', NO_ISSUE_KEY])
    expect(rows[1]).toMatchObject({ label: 'No issue', totalMs: 120 * MIN, catchAll: true })
  })

  test('an empty week rolls up to nothing at all', () => {
    expect(rollupByIssue([])).toEqual([])
  })

  test('the buckets add up to the weekly grand total', () => {
    const entries = [
      entry({ issueKey: 'FID2507-611', durationMs: 25 * MIN }),
      entry({ issueKey: null, durationMs: 40 * MIN }),
      entry({ issueKey: 'ABC-1', durationMs: 5 * MIN })
    ]
    expect(rollupByIssue(entries).reduce((s, r) => s + r.totalMs, 0)).toBe(totalMs(entries))
  })
})

describe('rollupByProject', () => {
  const projects = [
    project({ id: 'p1', name: 'Fabia', jiraJql: 'project = FID2507' }),
    project({ id: 'p2', name: 'Octavia', sortOrder: 1, jiraJql: 'project = OCT' })
  ]

  test('attributes time through the issue key the same way the boards do', () => {
    const rows = rollupByProject(
      [
        entry({ issueKey: 'FID2507-611', durationMs: 60 * MIN }),
        entry({ issueKey: 'OCT-4', durationMs: 90 * MIN }),
        entry({ issueKey: 'fid2507-900', durationMs: 30 * MIN })
      ],
      projects,
      []
    )
    expect(rows.map((r) => [r.key, r.label, r.totalMs])).toEqual([
      ['p1', 'Fabia', 90 * MIN],
      ['p2', 'Octavia', 90 * MIN]
    ])
  })

  test('a manual issue assignment moves that issue’s logged time too', () => {
    const overrides: ProjectOverride[] = [{ kind: 'jira', key: 'FID2507-611', projectId: 'p2' }]
    const rows = rollupByProject(
      [entry({ issueKey: 'FID2507-611', durationMs: 60 * MIN })],
      projects,
      overrides
    )
    expect(rows.map((r) => [r.key, r.totalMs])).toEqual([['p2', 60 * MIN]])
  })

  test('time with no issue, an unmatched issue, or a vanished project all land in Other', () => {
    const overrides: ProjectOverride[] = [{ kind: 'jira', key: 'GONE-1', projectId: 'deleted' }]
    const rows = rollupByProject(
      [
        entry({ issueKey: null, durationMs: 20 * MIN }),
        entry({ issueKey: 'ZZZ-9', durationMs: 10 * MIN }),
        entry({ issueKey: 'GONE-1', durationMs: 5 * MIN }),
        entry({ issueKey: 'OCT-4', durationMs: 60 * MIN })
      ],
      projects,
      overrides
    )
    expect(rows.map((r) => r.key)).toEqual(['p2', OTHER_PROJECT_KEY])
    expect(rows[1]).toMatchObject({ label: 'Other', totalMs: 35 * MIN, entries: 3, catchAll: true })
  })

  test('an archived project still names the time it already holds', () => {
    const rows = rollupByProject(
      [entry({ issueKey: 'FID2507-611', durationMs: 60 * MIN })],
      [project({ id: 'p1', name: 'Fabia', archived: true })],
      [{ kind: 'jira', key: 'FID2507-611', projectId: 'p1' }]
    )
    expect(rows.map((r) => [r.label, r.catchAll])).toEqual([['Fabia', false]])
  })

  test('the buckets add up to the weekly grand total', () => {
    const entries = [
      entry({ issueKey: 'FID2507-611', durationMs: 25 * MIN }),
      entry({ issueKey: null, durationMs: 40 * MIN }),
      entry({ issueKey: 'OCT-4', durationMs: 5 * MIN })
    ]
    expect(rollupByProject(entries, projects, []).reduce((s, r) => s + r.totalMs, 0)).toBe(
      totalMs(entries)
    )
  })

  test('an empty week rolls up to nothing at all', () => {
    expect(rollupByProject([], projects, [])).toEqual([])
  })
})
