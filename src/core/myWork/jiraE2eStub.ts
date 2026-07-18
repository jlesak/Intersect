import type { JiraLoginResult } from '@common/domain'
import type { JiraFetchResult } from './jiraClient'
import type { JiraRemoteIssue } from './jiraMapping'

/**
 * Deterministic Jira fetch backend for E2E runs, plugged in at the adapter seam so the real sync
 * engine, cache repo, and migrations still run without a Jira session or network access.
 * `INTERSECT_E2E_JIRA` picks the first fetch's outcome: `empty` (default), `board`, `auth`, or
 * `error`. In `auth` mode a stub login succeeds (unless `INTERSECT_E2E_JIRA_LOGIN=fail`) and
 * flips subsequent fetches to `board`, mirroring the real login-then-refresh flow end to end.
 */
export interface JiraE2eStub {
  fetchBoard(): Promise<JiraFetchResult>
  login(): Promise<JiraLoginResult>
}

const remoteIssue = (over: Partial<JiraRemoteIssue> & Pick<JiraRemoteIssue, 'key'>): JiraRemoteIssue => ({
  summary: '',
  description: null,
  rawStatus: 'To Do',
  rawPriority: null,
  assignee: null,
  epicKey: null,
  epicSummary: null,
  estimateSeconds: null,
  components: [],
  updatedAt: Date.now(),
  ...over
})

const SAMPLE_ISSUES: JiraRemoteIssue[] = [
  remoteIssue({
    key: 'FID2507-1',
    summary: 'Prepare the release notes',
    rawStatus: 'To Do',
    rawPriority: 'Medium',
    updatedAt: Date.now() - 60 * 60_000
  }),
  remoteIssue({
    key: 'FID2507-2',
    summary: 'Implement the login flow',
    rawStatus: 'In Progress',
    rawPriority: 'High',
    updatedAt: Date.now() - 30 * 60_000
  }),
  remoteIssue({
    key: 'FID2507-3',
    summary: 'Verify the board states',
    rawStatus: 'In Review',
    rawPriority: 'Low',
    updatedAt: Date.now() - 5 * 60_000
  })
]

export function createJiraE2eStub(env: NodeJS.ProcessEnv): JiraE2eStub {
  let mode = env.INTERSECT_E2E_JIRA ?? 'empty'
  return {
    async fetchBoard() {
      switch (mode) {
        case 'auth':
          return { ok: false, kind: 'auth', message: 'Not logged in: no saved Jira session' }
        case 'error':
          return { ok: false, kind: 'other', message: 'Stubbed fetch failure' }
        case 'board':
          return { ok: true, issues: SAMPLE_ISSUES, partial: false }
        default:
          return { ok: true, issues: [], partial: false }
      }
    },
    async login() {
      // A real login keeps a browser window open for a while; a short pause keeps the sign-in
      // state observable so the e2e specs can assert it.
      await new Promise((resolve) => setTimeout(resolve, 800))
      if (env.INTERSECT_E2E_JIRA_LOGIN === 'fail') {
        return { ok: false, message: 'The Jira login was not completed (window closed or timed out).' }
      }
      mode = 'board'
      return { ok: true }
    }
  }
}
