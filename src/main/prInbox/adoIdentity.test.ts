import { describe, expect, test, vi } from 'vitest'
import { classifyIdentity, createIdentityResolver, fetchConnectionIdentity } from './adoIdentity'

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status })

describe('classifyIdentity', () => {
  test('a UUID becomes an id (the server-side filterable form)', () => {
    expect(classifyIdentity('6dc11d09-387d-4a25-8699-0dc709e21280')).toEqual({
      id: '6dc11d09-387d-4a25-8699-0dc709e21280'
    })
  })

  test('a domain\\user becomes a uniqueName', () => {
    expect(classifyIdentity('SKODA\\jlesak')).toEqual({ uniqueName: 'SKODA\\jlesak' })
  })

  test('anything else becomes a display name', () => {
    expect(classifyIdentity('Jan Lesák')).toEqual({ displayName: 'Jan Lesák' })
  })
})

describe('fetchConnectionIdentity', () => {
  test('derives the identity from connectionData.authenticatedUser, using the preview api-version', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        authenticatedUser: {
          id: '6dc11d09-387d-4a25-8699-0dc709e21280',
          providerDisplayName: 'Jan Lesák'
        }
      })
    )
    const identity = await fetchConnectionIdentity('https://devops.example.com/tfs/Collection/', 'the-pat', {
      fetchFn
    })
    expect(identity).toEqual({
      id: '6dc11d09-387d-4a25-8699-0dc709e21280',
      displayName: 'Jan Lesák'
    })
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'https://devops.example.com/tfs/Collection/_apis/connectionData?api-version=7.0-preview.1'
    )
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from(':the-pat').toString('base64')}`
    )
  })

  test('rejects an HTML sign-in page (HTTP 200) rather than returning an empty identity', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<!DOCTYPE html><title>Sign in</title>', { status: 200 }))
    await expect(
      fetchConnectionIdentity('https://devops.example.com', 'pat', { fetchFn })
    ).rejects.toThrow(/sign-in page|did not return an identity/i)
  })

  test('rejects a non-OK response', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('nope', { status: 401 }))
    await expect(
      fetchConnectionIdentity('https://devops.example.com', 'pat', { fetchFn })
    ).rejects.toThrow(/HTTP 401/)
  })
})

describe('createIdentityResolver', () => {
  const creds = { orgUrl: 'https://devops.example.com', pat: 'the-pat' }

  test('an INTERSECT_ADO_IDENTITY override wins and makes no network call', async () => {
    const fetchFn = vi.fn<typeof fetch>()
    const resolve = createIdentityResolver({
      resolveCredentials: () => creds,
      env: { INTERSECT_ADO_IDENTITY: '6dc11d09-387d-4a25-8699-0dc709e21280' } as NodeJS.ProcessEnv,
      fetchFn
    })
    expect(await resolve()).toEqual({ id: '6dc11d09-387d-4a25-8699-0dc709e21280' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  test('with no override, derives from the PAT and memoizes the result', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ authenticatedUser: { id: 'uuid-1' } }))
    const resolve = createIdentityResolver({
      resolveCredentials: () => creds,
      env: {} as NodeJS.ProcessEnv,
      fetchFn
    })
    expect(await resolve()).toEqual({ id: 'uuid-1', displayName: undefined })
    expect(await resolve()).toEqual({ id: 'uuid-1', displayName: undefined })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  test('a failed lookup is not cached, so a later call can still succeed', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(jsonResponse({ authenticatedUser: { id: 'uuid-2' } }))
    const resolve = createIdentityResolver({
      resolveCredentials: () => creds,
      env: {} as NodeJS.ProcessEnv,
      fetchFn
    })
    await expect(resolve()).rejects.toThrow(/offline/)
    expect(await resolve()).toEqual({ id: 'uuid-2', displayName: undefined })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})
