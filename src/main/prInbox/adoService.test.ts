import { describe, expect, test } from 'vitest'
import type { AdoClient } from './adoClient'
import { createAdoService } from './adoService'

type ToolHandler = unknown | ((args: Record<string, unknown>) => unknown)

/** Fake MCP client answering from a canned tool->result map (functions get the args). */
function fakeClient(handlers: Record<string, ToolHandler>): AdoClient {
  return {
    async callTool(name, args) {
      if (!(name in handlers)) throw new Error(`Unexpected tool call: ${name}`)
      const h = handlers[name]
      return (
        typeof h === 'function' ? (h as (a: Record<string, unknown>) => unknown)(args) : h
      ) as never
    },
    async close() {}
  }
}

const deps = (client: AdoClient) => ({
  client,
  resolveIdentity: async () => ({ id: 'me-uuid', displayName: 'Me', uniqueName: 'me@x' }),
  projectId: () => 'SPOT',
  resolveVoteCredentials: () => ({ orgUrl: 'https://o', pat: 'p' })
})

describe('getThreads', () => {
  test('maps system threads and normalizes numeric status', async () => {
    const svc = createAdoService(
      deps(
        fakeClient({
          get_pull_request_comments: {
            value: [
              {
                id: 1,
                status: 1,
                threadContext: { filePath: '/a.cs', rightFileStart: { line: 4 } },
                comments: [{ author: { displayName: 'X' }, content: 'real', commentType: 'text' }]
              },
              {
                id: 2,
                status: 'unknown',
                comments: [
                  {
                    author: { displayName: 'Sys' },
                    content: 'Policy status has been updated',
                    commentType: 'system'
                  }
                ]
              },
              {
                id: 3,
                status: 2,
                threadContext: { filePath: '/a.cs', rightFileStart: { line: 9 } },
                comments: [{ author: { displayName: 'Y' }, content: 'done', commentType: 'text' }]
              }
            ]
          }
        })
      )
    )
    const threads = await svc.getThreads('repo', 7)
    expect(threads[0]).toMatchObject({ threadId: 1, status: 'active', isSystem: false, line: 4 })
    expect(threads[1]).toMatchObject({ threadId: 2, isSystem: true })
    expect(threads[2]).toMatchObject({ threadId: 3, status: 'fixed' })
  })

  test('a thread without commentType stays non-system', async () => {
    const svc = createAdoService(
      deps(
        fakeClient({
          get_pull_request_comments: {
            value: [{ id: 1, status: 'active', comments: [{ content: 'legacy payload' }] }]
          }
        })
      )
    )
    const threads = await svc.getThreads('repo', 7)
    expect(threads[0].isSystem).toBe(false)
  })
})

describe('thread mutations', () => {
  test('replyToThread posts into the thread', async () => {
    const calls: Array<Record<string, unknown>> = []
    const svc = createAdoService(
      deps(
        fakeClient({
          add_pull_request_comment: (args) => {
            calls.push(args)
            return { id: 5 }
          }
        })
      )
    )
    await svc.replyToThread({ repositoryId: 'repo', prId: 7, threadId: 42, body: 'hi' })
    expect(calls[0]).toMatchObject({ pullRequestId: 7, threadId: 42, content: 'hi' })
  })

  test('setThreadStatus updates the thread status', async () => {
    const calls: Array<Record<string, unknown>> = []
    const svc = createAdoService(
      deps(
        fakeClient({
          update_pull_request_thread_status: (args) => {
            calls.push(args)
            return {}
          }
        })
      )
    )
    await svc.setThreadStatus({ repositoryId: 'repo', prId: 7, threadId: 42, status: 'fixed' })
    expect(calls[0]).toMatchObject({ pullRequestId: 7, threadId: 42, status: 'fixed' })
  })

  test('publishComment omits file anchoring for a PR-level comment', async () => {
    const calls: Array<Record<string, unknown>> = []
    const svc = createAdoService(
      deps(
        fakeClient({
          add_pull_request_comment: (args) => {
            calls.push(args)
            return { id: 6 }
          }
        })
      )
    )
    const threadId = await svc.publishComment({
      repositoryId: 'repo',
      prId: 7,
      filePath: null,
      line: null,
      body: 'pr-level'
    })
    expect(threadId).toBe(6)
    expect(calls[0]).not.toHaveProperty('filePath')
    expect(calls[0]).not.toHaveProperty('lineNumber')
  })
})

describe('syncMyPrs thread enrichment', () => {
  const rawPr = {
    pullRequestId: 9,
    title: 'T',
    status: 'active',
    createdBy: { id: 'other', displayName: 'O' },
    reviewers: [{ id: 'me-uuid', displayName: 'Me', vote: 0 }],
    repository: { id: 'repo-1', name: 'repo', project: { id: 'SPOT' } },
    sourceRefName: 'refs/heads/f',
    targetRefName: 'refs/heads/main'
  }

  test('counts unresolved non-system threads per PR', async () => {
    const svc = createAdoService(
      deps(
        fakeClient({
          list_repositories: [{ id: 'repo-1', name: 'repo' }],
          list_pull_requests: (args) => ({ value: args.reviewerId ? [rawPr] : [] }),
          get_pull_request_comments: {
            value: [
              { id: 1, status: 'active', comments: [{ content: 'c', commentType: 'text' }] },
              { id: 2, status: 'fixed', comments: [{ content: 'c', commentType: 'text' }] },
              { id: 3, status: 'active', comments: [{ content: 's', commentType: 'system' }] }
            ]
          }
        })
      )
    )
    const { prs } = await svc.syncMyPrs()
    expect(prs).toHaveLength(1)
    expect(prs[0].activeThreadCount).toBe(1)
  })

  test('a failing thread fetch degrades to 0 without failing the sync', async () => {
    const svc = createAdoService(
      deps(
        fakeClient({
          list_repositories: [{ id: 'repo-1', name: 'repo' }],
          list_pull_requests: (args) => ({ value: args.reviewerId ? [rawPr] : [] }),
          get_pull_request_comments: () => {
            throw new Error('boom')
          }
        })
      )
    )
    const { prs } = await svc.syncMyPrs()
    expect(prs).toHaveLength(1)
    expect(prs[0].activeThreadCount).toBe(0)
  })
})
