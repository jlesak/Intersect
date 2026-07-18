import { describe, expect, test } from 'vitest'
import { mapPriority, mapStatusToColumn, toIssues, type RawJiraIssue } from './jiraMapping'

const raw = (over: Partial<RawJiraIssue> = {}): RawJiraIssue => ({
  key: 'FID2507-1',
  summary: 'An issue',
  status: 'To Do',
  priority: 'Medium',
  updated: '2026-07-01T10:00:00.000+0200',
  ...over
})

describe('mapStatusToColumn', () => {
  test.each([
    ['To Do', 'todo'],
    ['Open', 'todo'],
    ['Backlog', 'todo'],
    ['Reopened', 'todo'],
    ['In Progress', 'progress'],
    ['Progress', 'progress'],
    ['In Development', 'progress'],
    ['Waiting', 'waiting'],
    ['On Hold', 'waiting'],
    ['Blocked', 'waiting'],
    ['Review', 'review'],
    ['In Review', 'review'],
    ['Code Review', 'review'],
    ['Test', 'test'],
    ['In Testing', 'test'],
    ['Ready for Test', 'test'],
    ['QA', 'test']
  ])('maps %s to the %s column', (status, column) => {
    expect(mapStatusToColumn(status)).toBe(column)
  })

  test('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(mapStatusToColumn('  IN PROGRESS  ')).toBe('progress')
  })

  test('compound names land in the most specific column', () => {
    expect(mapStatusToColumn('Waiting for review')).toBe('review')
    expect(mapStatusToColumn('Ready for Test')).toBe('test')
  })

  test('an unknown status defaults to To Do', () => {
    expect(mapStatusToColumn('Something Custom')).toBe('todo')
    expect(mapStatusToColumn('')).toBe('todo')
  })

  test('does not read "test" out of an unrelated word', () => {
    expect(mapStatusToColumn('Latest')).toBe('todo')
  })
})

describe('mapPriority', () => {
  test.each([
    ['Highest', 'high'],
    ['High', 'high'],
    ['Blocker', 'high'],
    ['Critical', 'high'],
    ['Medium', 'medium'],
    ['Major', 'medium'],
    ['Low', 'low'],
    ['Lowest', 'low'],
    ['Minor', 'low'],
    ['Trivial', 'low']
  ])('maps %s to %s', (name, bucket) => {
    expect(mapPriority(name)).toBe(bucket)
  })

  test('null, empty and unrecognized names map to null', () => {
    expect(mapPriority(null)).toBeNull()
    expect(mapPriority('')).toBeNull()
    expect(mapPriority('Whatever')).toBeNull()
  })
})

describe('toIssues', () => {
  test('builds the canonical browse URL from the key', () => {
    const [issue] = toIssues([raw({ key: 'FID2507-611' })])
    expect(issue.url).toBe('https://jira.skoda.vwgroup.com/browse/FID2507-611')
  })

  test('maps status and priority and parses updated to epoch ms', () => {
    const [issue] = toIssues([
      raw({ status: 'In Review', priority: 'High', updated: '2026-07-01T08:00:00.000Z' })
    ])
    expect(issue.column).toBe('review')
    expect(issue.priority).toBe('high')
    expect(issue.updatedAt).toBe(Date.parse('2026-07-01T08:00:00.000Z'))
  })

  test('sorts by last activity, newest first', () => {
    const issues = toIssues([
      raw({ key: 'A-1', updated: '2026-07-01T00:00:00Z' }),
      raw({ key: 'A-3', updated: '2026-07-03T00:00:00Z' }),
      raw({ key: 'A-2', updated: '2026-07-02T00:00:00Z' })
    ])
    expect(issues.map((i) => i.key)).toEqual(['A-3', 'A-2', 'A-1'])
  })

  test('drops entries without a key and sorts an unparseable timestamp last', () => {
    const issues = toIssues([
      raw({ key: '  ' }),
      raw({ key: 'A-1', updated: 'not a date' }),
      raw({ key: 'A-2', updated: '2026-07-01T00:00:00Z' })
    ])
    expect(issues.map((i) => i.key)).toEqual(['A-2', 'A-1'])
    expect(issues[1].updatedAt).toBe(0)
  })
})
