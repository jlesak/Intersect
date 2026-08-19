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

const deps = (
  client: AdoClient,
  priorThreadCount: (r: string, p: number) => number = () => 0,
  priorActivityAt: (r: string, p: number) => number = () => 0
) => ({
  client,
  resolveIdentity: async () => ({ id: 'me-uuid', displayName: 'Me', uniqueName: 'me@x' }),
  projectId: () => 'SPOT',
  priorThreadCount,
  priorActivityAt,
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
            return { comment: { id: 1 }, thread: { id: 6 } }
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

  test('publishComment reads the thread id out of the wrapped {comment, thread} result', async () => {
    // The real MCP server answers a new-thread write with the created comment next to the created
    // thread, so the id lives one level down. Reading the top level found nothing and threw after
    // the comment was already live on the pull request.
    const svc = createAdoService(
      deps(
        fakeClient({
          add_pull_request_comment: () => ({
            comment: { id: 1, content: 'x', commentType: 'text' },
            thread: {
              id: 12345,
              status: 'active',
              threadContext: { filePath: '/src/a.cs', rightFileStart: { line: 4 } },
              comments: [{ id: 1, content: 'x', commentType: 'text' }]
            }
          })
        })
      )
    )
    const threadId = await svc.publishComment({
      repositoryId: 'repo',
      prId: 7,
      filePath: '/src/a.cs',
      line: 4,
      body: 'x'
    })
    expect(threadId).toBe(12345)
  })

  test('publishComment falls back to a flat thread payload', async () => {
    const svc = createAdoService(
      deps(fakeClient({ add_pull_request_comment: () => ({ id: 6, status: 'active' }) }))
    )
    expect(
      await svc.publishComment({ repositoryId: 'repo', prId: 7, filePath: null, line: null, body: 'x' })
    ).toBe(6)
  })

  test('publishComment returns null instead of throwing when the write carried no thread id', async () => {
    // The write already reached Azure DevOps, so an unreadable id must not look like a failed post.
    const svc = createAdoService(
      deps(fakeClient({ add_pull_request_comment: () => ({ comment: { id: 1 } }) }))
    )
    expect(
      await svc.publishComment({ repositoryId: 'repo', prId: 7, filePath: null, line: null, body: 'x' })
    ).toBeNull()
  })
})

const CREATED = '2026-07-01T10:00:00.000Z'

const rawPr = {
  pullRequestId: 9,
  title: 'T',
  status: 'active',
  creationDate: CREATED,
  createdBy: { id: 'other', displayName: 'O' },
  reviewers: [{ id: 'me-uuid', displayName: 'Me', vote: 0 }],
  repository: { id: 'repo-1', name: 'repo', project: { id: 'SPOT' } },
  sourceRefName: 'refs/heads/f',
  targetRefName: 'refs/heads/main'
}

/** The two list calls every sync makes, answering with the one PR I review. */
const listHandlers = {
  list_repositories: [{ id: 'repo-1', name: 'repo' }],
  list_pull_requests: (args: Record<string, unknown>) => ({ value: args.reviewerId ? [rawPr] : [] })
}

describe('syncMyPrs thread enrichment', () => {
  test('accepts the Azure DevOps collection envelope for repositories', async () => {
    const svc = createAdoService(
      deps(
        fakeClient({
          list_repositories: { count: 1, value: [{ id: 'repo-1', name: 'repo' }] },
          list_pull_requests: (args) => ({ value: args.reviewerId ? [rawPr] : [] }),
          get_pull_request_comments: { value: [] }
        })
      )
    )

    const { prs } = await svc.syncMyPrs()

    expect(prs).toHaveLength(1)
    expect(prs[0]).toMatchObject({ repositoryId: 'repo-1', repositoryName: 'repo' })
  })

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

  test('a failing thread fetch preserves the last-known count instead of resetting to 0', async () => {
    const svc = createAdoService(
      deps(
        fakeClient({
          list_repositories: [{ id: 'repo-1', name: 'repo' }],
          list_pull_requests: (args) => ({ value: args.reviewerId ? [rawPr] : [] }),
          get_pull_request_comments: () => {
            throw new Error('boom')
          }
        }),
        (_repositoryId, prId) => (prId === 9 ? 3 : 0)
      )
    )
    const { prs } = await svc.syncMyPrs()
    expect(prs).toHaveLength(1)
    expect(prs[0].activeThreadCount).toBe(3)
  })

  test('a failing thread fetch degrades to 0 when there is no cached count', async () => {
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

describe('syncMyPrs activity derivation', () => {
  test('the newest comment of any thread dates the PR, system threads included', async () => {
    const newest = '2026-07-09T08:30:00.000Z'
    const svc = createAdoService(
      deps(
        fakeClient({
          ...listHandlers,
          get_pull_request_comments: {
            value: [
              {
                id: 1,
                status: 'active',
                comments: [
                  { content: 'older', commentType: 'text', publishedDate: '2026-07-05T09:00:00.000Z' },
                  { content: 'newer', commentType: 'text', publishedDate: '2026-07-06T09:00:00.000Z' }
                ]
              },
              {
                id: 2,
                status: 'closed',
                comments: [
                  { content: 'pushed a commit', commentType: 'system', publishedDate: newest }
                ]
              }
            ]
          }
        })
      )
    )
    const { prs } = await svc.syncMyPrs()
    expect(prs[0].lastActivityAt).toBe(Date.parse(newest))
    // The unresolved count still ignores system threads; only the activity clock counts them.
    expect(prs[0].activeThreadCount).toBe(1)
  })

  test('a PR with no threads at all is dated by its own creation', async () => {
    const svc = createAdoService(
      deps(fakeClient({ ...listHandlers, get_pull_request_comments: { value: [] } }))
    )
    const { prs } = await svc.syncMyPrs()
    expect(prs[0].lastActivityAt).toBe(Date.parse(CREATED))
  })

  test('a comment carrying no publish date loses to the creation floor', async () => {
    const svc = createAdoService(
      deps(
        fakeClient({
          ...listHandlers,
          get_pull_request_comments: {
            value: [{ id: 1, status: 'active', comments: [{ content: 'c', commentType: 'text' }] }]
          }
        })
      )
    )
    const { prs } = await svc.syncMyPrs()
    expect(prs[0].lastActivityAt).toBe(Date.parse(CREATED))
  })

  test('a comment older than the PR itself cannot backdate it', async () => {
    const svc = createAdoService(
      deps(
        fakeClient({
          ...listHandlers,
          get_pull_request_comments: {
            value: [
              {
                id: 1,
                status: 'active',
                comments: [
                  { content: 'c', commentType: 'text', publishedDate: '2026-06-01T00:00:00.000Z' }
                ]
              }
            ]
          }
        })
      )
    )
    const { prs } = await svc.syncMyPrs()
    expect(prs[0].lastActivityAt).toBe(Date.parse(CREATED))
  })

  test('a failing thread fetch keeps the last-known activity so the card does not move', async () => {
    const cached = Date.parse('2026-07-08T12:00:00.000Z')
    const svc = createAdoService(
      deps(
        fakeClient({
          ...listHandlers,
          get_pull_request_comments: () => {
            throw new Error('boom')
          }
        }),
        () => 0,
        (_repositoryId, prId) => (prId === 9 ? cached : 0)
      )
    )
    const { prs } = await svc.syncMyPrs()
    expect(prs[0].lastActivityAt).toBe(cached)
  })

  test('a failing thread fetch with nothing cached still falls back to the creation floor', async () => {
    const svc = createAdoService(
      deps(
        fakeClient({
          ...listHandlers,
          get_pull_request_comments: () => {
            throw new Error('boom')
          }
        })
      )
    )
    const { prs } = await svc.syncMyPrs()
    expect(prs[0].lastActivityAt).toBe(Date.parse(CREATED))
  })
})
