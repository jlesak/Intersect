import { describe, expect, test, vi } from 'vitest'
import { castVote, type CastVoteRequest } from './adoVote'

const req: CastVoteRequest = {
  orgUrl: 'https://devops.example.com/tfs/DefaultCollection/',
  pat: 'secret-pat',
  projectId: 'SPOT',
  repositoryId: 'c2941d43',
  prId: 33719,
  reviewerId: '6dc11d09-387d-4a25-8699-0dc709e21280',
  vote: 'approved'
}

function fetchReturning(response: Response): ReturnType<typeof vi.fn> & typeof fetch {
  return vi.fn(async () => response) as unknown as ReturnType<typeof vi.fn> & typeof fetch
}

describe('castVote', () => {
  test('PUTs the PR reviewer resource with the numeric vote and Basic PAT auth', async () => {
    const fetchFn = fetchReturning(new Response('{}', { status: 200 }))
    await castVote(req, { fetchFn })

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'https://devops.example.com/tfs/DefaultCollection/SPOT/_apis/git/repositories/' +
        'c2941d43/pullRequests/33719/reviewers/6dc11d09-387d-4a25-8699-0dc709e21280' +
        '?api-version=7.0'
    )
    expect(init.method).toBe('PUT')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(':secret-pat').toString('base64')}`)
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ vote: 10 })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  test.each([
    ['approvedWithSuggestions', 5],
    ['waiting', -5]
  ] as const)('sends the %s vote as %s', async (vote, numeric) => {
    const fetchFn = fetchReturning(new Response('{}', { status: 200 }))
    await castVote({ ...req, vote }, { fetchFn })
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ vote: numeric })
  })

  test('a 2xx response resolves without touching the body', async () => {
    const fetchFn = fetchReturning(new Response(null, { status: 204 }))
    await expect(castVote(req, { fetchFn })).resolves.toBeUndefined()
  })

  test('a non-2xx response throws with the status and trimmed body, never the PAT', async () => {
    const fetchFn = fetchReturning(
      new Response('  TF401019: The Git repository does not exist.  ', { status: 403 })
    )
    const failure = await castVote(req, { fetchFn }).catch((e: unknown) => e as Error)
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain('403')
    expect(message).toContain('TF401019: The Git repository does not exist.')
    expect(message).not.toContain('secret-pat')
    expect(message).not.toContain(Buffer.from(':secret-pat').toString('base64'))
  })

  test('an unreadable error body still reports the status', async () => {
    const fetchFn = fetchReturning(new Response(null, { status: 500 }))
    await expect(castVote(req, { fetchFn })).rejects.toThrow(/HTTP 500/)
  })

  test('a hung server aborts via the timeout signal', async () => {
    const fetchFn: typeof fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    await expect(castVote(req, { fetchFn, timeoutMs: 5 })).rejects.toThrow()
  })
})

describe('HTML error bodies', () => {
  test('an on-prem HTML error page is reduced to its title', async () => {
    const html = '﻿<!DOCTYPE html><html><head><style>body{color:red}</style><title>TF400813: The user is not authorized.</title></head><body>...</body></html>'
    const fetchFn = vi.fn(async () => new Response(html, { status: 401 }))
    const failing = castVote(req, { fetchFn: fetchFn as unknown as typeof fetch })
    await expect(failing).rejects.toThrow(/HTTP 401/)
    await expect(
      castVote(req, {
        fetchFn: vi.fn(async () => new Response(html, { status: 401 })) as unknown as typeof fetch
      })
    ).rejects.toSatisfy((e: Error) => {
      return (
        e.message.includes('TF400813: The user is not authorized.') &&
        !e.message.includes('DOCTYPE') &&
        !e.message.includes('color:red')
      )
    })
  })
})
