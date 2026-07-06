import type { JiraBoardResult, JiraIssue, JiraLoginResult } from '@common/domain'

/**
 * Deterministic My Work backend for E2E runs, so the UI's states can be exercised without a real
 * Jira session or a hidden Claude session. `INTERSECT_E2E_JIRA` picks the first fetch's outcome:
 * `empty` (default), `board`, `auth`, or `error`. In `auth` mode a stub login succeeds (unless
 * `INTERSECT_E2E_JIRA_LOGIN=fail`) and flips subsequent fetches to `board`, mirroring the real
 * login-then-refresh flow end to end.
 */
export interface JiraE2eStub {
  fetchBoard(): Promise<JiraBoardResult>
  login(): Promise<JiraLoginResult>
}

const SAMPLE_ISSUES: JiraIssue[] = [
  {
    key: 'FID2507-1',
    url: 'https://jira.skoda.vwgroup.com/browse/FID2507-1',
    summary: 'Prepare the release notes',
    column: 'todo',
    priority: 'medium',
    updatedAt: Date.now() - 60 * 60_000
  },
  {
    key: 'FID2507-2',
    url: 'https://jira.skoda.vwgroup.com/browse/FID2507-2',
    summary: 'Implement the login flow',
    column: 'progress',
    priority: 'high',
    updatedAt: Date.now() - 30 * 60_000
  },
  {
    key: 'FID2507-3',
    url: 'https://jira.skoda.vwgroup.com/browse/FID2507-3',
    summary: 'Verify the board states',
    column: 'review',
    priority: 'low',
    updatedAt: Date.now() - 5 * 60_000
  }
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
          return { ok: true, issues: SAMPLE_ISSUES, fetchedAt: Date.now() }
        default:
          return { ok: true, issues: [], fetchedAt: Date.now() }
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
