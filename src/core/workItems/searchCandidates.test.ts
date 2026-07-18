import { describe, expect, test } from 'vitest'
import type {
  JiraIssueSnapshot,
  Project,
  PullRequest,
  TodoTask
} from '@common/domain'
import { searchWorkItemCandidates, type WorkItemSearchData } from './searchCandidates'

const issue = (key: string, summary: string): JiraIssueSnapshot => ({
  key,
  url: `https://jira/browse/${key}`,
  summary,
  column: 'todo',
  priority: null,
  updatedAt: 1,
  description: null,
  rawStatus: 'To Do',
  rawPriority: null,
  assignee: null,
  epicKey: null,
  epicSummary: null,
  estimateSeconds: null,
  components: [],
  fetchedAt: 1,
  absent: false
})

const todo = (id: string, text: string): TodoTask => ({
  id,
  text,
  description: '',
  dueDay: null,
  priority: 4,
  sortOrder: 0,
  doneAt: null
})

const pr = (prId: number, title: string, repositoryName = 'spot-backend'): PullRequest => ({
  prId,
  repositoryId: 'repo-guid',
  repositoryName,
  projectId: 'ado-project',
  title,
  authorId: 'a',
  authorName: 'A',
  createdAt: 1,
  status: 'active',
  sourceRefName: 'refs/heads/f',
  targetRefName: 'refs/heads/main',
  sourceCommitId: '',
  targetCommitId: '',
  url: '',
  role: 'author',
  myVote: null,
  myReviewerId: null,
  reviewers: [],
  newChangesSinceMyReview: false,
  activeThreadCount: 0
})

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  name: id,
  sortOrder: 0,
  archived: false,
  repoPaths: [`/repos/${id}`],
  jiraJql: null,
  jiraBoardUrl: null,
  adoRepositories: [],
  togglProjectId: null,
  ...over
})

const data = (over: Partial<WorkItemSearchData> = {}): WorkItemSearchData => ({
  jiraIssues: [issue('FID-1', 'Fix login'), issue('FID-2', 'Broken build')],
  openTodos: [todo('t-1', 'Water plants'), todo('t-2', 'Fix the fence')],
  prs: [pr(12, 'Fix login flow'), pr(13, 'Add telemetry')],
  projects: [],
  overrides: [],
  ...over
})

describe('searchWorkItemCandidates', () => {
  test('an empty query returns every source grouped in jira/todo/pr order', () => {
    const groups = searchWorkItemCandidates('', undefined, data())
    expect(groups.map((g) => g.source)).toEqual(['jira', 'todo', 'ado-pr'])
    expect(groups[0].candidates).toHaveLength(2)
    expect(groups[1].candidates).toHaveLength(2)
    expect(groups[2].candidates).toHaveLength(2)
  })

  test('matches on key and title case-insensitively and drops empty groups', () => {
    const groups = searchWorkItemCandidates('fix', undefined, data())
    expect(groups.map((g) => g.source)).toEqual(['jira', 'todo', 'ado-pr'])
    expect(groups[0].candidates.map((c) => c.externalKey)).toEqual(['FID-1'])
    expect(groups[1].candidates.map((c) => c.snapshot.title)).toEqual(['Fix the fence'])
    expect(groups[2].candidates.map((c) => c.snapshot.key)).toEqual(['!12'])

    const keyed = searchWorkItemCandidates('fid-2', undefined, data())
    expect(keyed).toHaveLength(1)
    expect(keyed[0].candidates.map((c) => c.externalKey)).toEqual(['FID-2'])

    const byPrNumber = searchWorkItemCandidates('!13', undefined, data())
    expect(byPrNumber).toHaveLength(1)
    expect(byPrNumber[0].candidates.map((c) => c.snapshot.key)).toEqual(['!13'])
  })

  test('candidates carry prebuilt refs with binding-resolved projects', () => {
    const projects = [
      project('p1', { jiraJql: 'project = FID' }),
      project('p2', { adoRepositories: ['spot-backend'] })
    ]
    const groups = searchWorkItemCandidates('', undefined, data({ projects }))
    const jira = groups.find((g) => g.source === 'jira')
    const todos = groups.find((g) => g.source === 'todo')
    const prs = groups.find((g) => g.source === 'ado-pr')
    expect(jira?.candidates.map((c) => c.projectId)).toEqual(['p1', 'p1'])
    expect(todos?.candidates.map((c) => c.projectId)).toEqual([null, null])
    expect(prs?.candidates.map((c) => c.projectId)).toEqual(['p2', 'p2'])
  })

  test('a manual override beats binding inference in the prebuilt ref', () => {
    const projects = [project('p1', { jiraJql: 'project = FID' }), project('p3')]
    const groups = searchWorkItemCandidates(
      'FID-1',
      undefined,
      data({
        projects,
        overrides: [{ kind: 'jira', key: 'FID-1', projectId: 'p3' }]
      })
    )
    expect(groups[0].candidates[0].projectId).toBe('p3')
  })

  test('ranks the given project\'s candidates first within each group', () => {
    const projects = [
      project('p1', { jiraJql: 'project = OTHER' }),
      project('p2', { adoRepositories: ['spot-backend'] })
    ]
    const groups = searchWorkItemCandidates(
      '',
      'p2',
      data({
        projects,
        jiraIssues: [issue('OTHER-1', 'Elsewhere'), issue('NOPE-1', 'Unmatched')],
        overrides: [{ kind: 'jira', key: 'NOPE-1', projectId: 'p2' }]
      })
    )
    const jira = groups.find((g) => g.source === 'jira')
    expect(jira?.candidates.map((c) => c.externalKey)).toEqual(['NOPE-1', 'OTHER-1'])
  })
})
