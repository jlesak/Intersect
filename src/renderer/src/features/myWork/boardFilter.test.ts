import type { JiraIssueSnapshot } from '@common/domain'
import { describe, expect, test } from 'vitest'
import { NO_VALUE } from '@renderer/shared/selection'
import { NO_JIRA_FILTER, filterJiraIssues, jiraFilterOptions } from './boardFilter'

function issue(over: Partial<JiraIssueSnapshot> & Pick<JiraIssueSnapshot, 'key'>): JiraIssueSnapshot {
  return {
    url: `https://jira.test/browse/${over.key}`,
    summary: '',
    column: 'todo',
    priority: null,
    updatedAt: 0,
    description: null,
    rawStatus: 'To Do',
    rawPriority: null,
    assignee: null,
    epicKey: null,
    epicSummary: null,
    estimateSeconds: null,
    components: [],
    fetchedAt: 0,
    absent: false,
    ...over
  }
}

const EXCEL = issue({
  key: 'FID2507-11',
  summary: 'Rework the spreadsheet exporter',
  assignee: 'Jan Lesak',
  epicKey: 'FID2507-90',
  epicSummary: 'Reporting',
  components: ['Excel', 'Backend']
})
const LOGIN = issue({
  key: 'FID2507-12',
  summary: 'Implement the login flow',
  assignee: 'Marek Kral',
  epicKey: 'FID2507-91',
  epicSummary: 'Platform',
  components: ['Backend']
})
const LOOSE = issue({ key: 'FID2507-13', summary: 'Tidy the changelog' })

const ALL = [EXCEL, LOGIN, LOOSE]
const keys = (issues: readonly JiraIssueSnapshot[]): string[] => issues.map((i) => i.key)

describe('filterJiraIssues', () => {
  test('an empty filter keeps every issue in the order given', () => {
    expect(filterJiraIssues(ALL, NO_JIRA_FILTER)).toEqual(ALL)
  })

  test('free text finds an issue by scattered letters of its summary, not just by substring', () => {
    // "sprdsht" appears nowhere in the text as a run; only a real subsequence matcher finds it.
    const found = filterJiraIssues(ALL, { ...NO_JIRA_FILTER, query: 'sprdsht' })
    expect(keys(found)).toEqual(['FID2507-11'])
  })

  test('free text finds an issue by its key', () => {
    expect(keys(filterJiraIssues(ALL, { ...NO_JIRA_FILTER, query: 'FID2507-12' }))).toEqual([
      'FID2507-12'
    ])
  })

  test('free text finds an issue by who it is assigned to', () => {
    expect(keys(filterJiraIssues(ALL, { ...NO_JIRA_FILTER, query: 'Marek' }))).toEqual([
      'FID2507-12'
    ])
  })

  test('surviving issues keep the order they came in, so the columns own their sort', () => {
    // All three match "t", but the shared matcher ranks the changelog issue best - a result that
    // simply handed the ranking through would come back in a different order from this one.
    const found = filterJiraIssues(ALL, { ...NO_JIRA_FILTER, query: 't' })
    expect(keys(found)).toEqual(['FID2507-11', 'FID2507-12', 'FID2507-13'])
  })

  test('a component chip drops the issues that do not carry it, including those with none', () => {
    const found = filterJiraIssues(ALL, { ...NO_JIRA_FILTER, components: ['Excel'] })
    expect(keys(found)).toEqual(['FID2507-11'])
  })

  test('an issue carrying any one of the chosen components survives', () => {
    const found = filterJiraIssues(ALL, { ...NO_JIRA_FILTER, components: ['Backend'] })
    expect(keys(found)).toEqual(['FID2507-11', 'FID2507-12'])
  })

  test('an epic picked on its own drops the other epics, and the issues under no epic with them', () => {
    const found = filterJiraIssues(ALL, { ...NO_JIRA_FILTER, epics: ['FID2507-91'] })
    expect(keys(found)).toEqual(['FID2507-12'])
  })

  test('the issues under no epic are reachable as a choice of their own', () => {
    const found = filterJiraIssues(ALL, { ...NO_JIRA_FILTER, epics: [NO_VALUE] })
    expect(keys(found)).toEqual(['FID2507-13'])
  })

  test('a chip choice the board no longer offers stops narrowing rather than emptying the board', () => {
    // The control that set this is gone from the screen once no issue carries a component.
    const bare = ALL.map((i) => ({ ...i, components: [] }))
    expect(keys(filterJiraIssues(bare, { ...NO_JIRA_FILTER, components: ['Excel'] }))).toEqual([
      'FID2507-11',
      'FID2507-12',
      'FID2507-13'
    ])
  })

  test('one choice vanishing does not lift the rest of the narrowing', () => {
    const found = filterJiraIssues(ALL, { ...NO_JIRA_FILTER, components: ['Excel', 'Gone'] })
    expect(keys(found)).toEqual(['FID2507-11'])
  })

  test('choosing nothing in a chip control leaves the board empty rather than unfiltered', () => {
    expect(filterJiraIssues(ALL, { ...NO_JIRA_FILTER, components: [] })).toEqual([])
  })

  test('text and chips narrow together', () => {
    const both = { query: 'e', epics: null, components: ['Backend'] }
    expect(keys(filterJiraIssues(ALL, both))).toEqual(['FID2507-11', 'FID2507-12'])
    expect(keys(filterJiraIssues(ALL, { ...both, query: 'sprdsht' }))).toEqual(['FID2507-11'])
  })
})

describe('jiraFilterOptions', () => {
  test('offers each component once, whichever issues carry it, then the ones carrying none', () => {
    expect(jiraFilterOptions(ALL).components).toEqual([
      { value: 'Backend', label: 'Backend' },
      { value: 'Excel', label: 'Excel' },
      { value: NO_VALUE, label: '(none)' }
    ])
  })

  test('offers each epic once, named by its summary and listed under that name', () => {
    expect(jiraFilterOptions(ALL).epics).toEqual([
      { value: 'FID2507-91', label: 'Platform' },
      { value: 'FID2507-90', label: 'Reporting' },
      { value: NO_VALUE, label: '(none)' }
    ])
  })

  test('a board where every issue has an epic offers no "(none)" to pick', () => {
    expect(jiraFilterOptions([EXCEL, LOGIN]).epics).toEqual([
      { value: 'FID2507-91', label: 'Platform' },
      { value: 'FID2507-90', label: 'Reporting' }
    ])
  })

  test('an epic whose summary only one issue knows is still named by it', () => {
    const anonymous = issue({ key: 'FID2507-14', epicKey: 'FID2507-90', epicSummary: null })
    expect(jiraFilterOptions([anonymous, EXCEL]).epics).toEqual([
      { value: 'FID2507-90', label: 'Reporting' }
    ])
    expect(jiraFilterOptions([EXCEL, anonymous]).epics).toEqual([
      { value: 'FID2507-90', label: 'Reporting' }
    ])
  })

  test('an epic nobody named falls back to its key', () => {
    const anonymous = issue({ key: 'FID2507-14', epicKey: 'FID2507-90', epicSummary: null })
    expect(jiraFilterOptions([anonymous]).epics).toEqual([
      { value: 'FID2507-90', label: 'FID2507-90' }
    ])
  })

  test('a board whose issues carry no epic or component offers nothing to choose from', () => {
    expect(jiraFilterOptions([LOOSE])).toEqual({ epics: [], components: [] })
  })
})
