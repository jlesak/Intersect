import { describe, expect, test, vi } from 'vitest'
import type { AdoSettings } from '@common/domain'
import { testAdoConnection } from './adoTestConnection'

const input = (over: Partial<AdoSettings> = {}): AdoSettings => ({
  orgUrl: 'https://devops.example.com/tfs/Collection',
  project: 'SPOT',
  repository: 'intersect-app',
  pat: 'the-pat',
  ...over
})

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status })

describe('testAdoConnection', () => {
  test('reports the authenticated user after both probes succeed', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ authenticatedUser: { providerDisplayName: 'Jan Lesák' } })
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'repo-1', name: 'intersect-app' }))

    const result = await testAdoConnection(input(), { fetchFn })
    expect(result).toEqual({ ok: true, displayName: 'Jan Lesák' })

    const [connUrl, connInit] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(connUrl).toBe(
      'https://devops.example.com/tfs/Collection/_apis/connectionData?api-version=7.0-preview.1'
    )
    expect((connInit.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from(':the-pat').toString('base64')}`
    )
    const [repoUrl] = fetchFn.mock.calls[1] as [string]
    expect(repoUrl).toBe(
      'https://devops.example.com/tfs/Collection/SPOT/_apis/git/repositories/intersect-app?api-version=7.0'
    )
  })

  test('skips the repository probe when project or repository is blank', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ authenticatedUser: { providerDisplayName: 'Jan' } }))
    const result = await testAdoConnection(input({ repository: '  ' }), { fetchFn })
    expect(result).toEqual({ ok: true, displayName: 'Jan' })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  test('trims a trailing slash off the org URL', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ authenticatedUser: { providerDisplayName: 'Jan' } }))
    await testAdoConnection(input({ orgUrl: 'https://devops.example.com/tfs/Collection/', repository: '' }), {
      fetchFn
    })
    expect(fetchFn.mock.calls[0][0]).toBe(
      'https://devops.example.com/tfs/Collection/_apis/connectionData?api-version=7.0-preview.1'
    )
  })

  test('requests the connectionData probe with the -preview flag the resource requires', async () => {
    // The connectionData resource of the Location service is preview-only; an on-prem server
    // rejects a plain released version with VssInvalidPreviewVersionException (HTTP 400).
    const preview400 = new Response(
      JSON.stringify({
        typeName: 'Microsoft.VisualStudio.Services.WebApi.VssInvalidPreviewVersionException',
        message: "version '7.0' of the resource is under preview"
      }),
      { status: 400 }
    )
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(preview400)
    await testAdoConnection(input({ repository: '' }), { fetchFn })
    expect(fetchFn.mock.calls[0][0]).toContain('api-version=7.0-preview')
  })

  test('maps a 401 to a rejected-PAT message without leaking the PAT', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('nope', { status: 401 }))
    const result = await testAdoConnection(input(), { fetchFn })
    expect(result).toEqual({ ok: false, error: 'Azure DevOps rejected the PAT (HTTP 401).' })
  })

  test('extracts the title from an HTML error page', async () => {
    const html = '<!DOCTYPE html><html><head><title>TF400813: not authorized</title></head></html>'
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(html, { status: 403 }))
    const result = await testAdoConnection(input(), { fetchFn })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('HTTP 403')
      expect(result.error).toContain('TF400813: not authorized')
      expect(result.error).not.toContain('DOCTYPE')
    }
  })

  test('rejects a HTTP 200 HTML sign-in page as an auth failure, not a raw parse error', async () => {
    const html = '<!DOCTYPE html><html><head><title>Please sign in</title></head><body>SSO</body></html>'
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(html, { status: 200 }))
    const result = await testAdoConnection(input({ repository: '' }), { fetchFn })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('rejected the PAT')
      expect(result.error).toContain('Please sign in')
      expect(result.error).not.toContain('DOCTYPE')
      expect(result.error).not.toMatch(/JSON|Unexpected token/i)
    }
  })

  test('a 404 on the repository probe names the missing project/repository', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ authenticatedUser: { providerDisplayName: 'Jan' } }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
    const result = await testAdoConnection(input(), { fetchFn })
    expect(result).toEqual({
      ok: false,
      error: 'Project "SPOT" or repository "intersect-app" was not found.'
    })
  })

  test('a thrown network error becomes a readable failure value', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'))
    const result = await testAdoConnection(input(), { fetchFn })
    expect(result).toEqual({ ok: false, error: 'Could not reach Azure DevOps: ECONNREFUSED' })
  })

  test('a timeout maps to its own message', async () => {
    const timeout = new Error('aborted')
    timeout.name = 'TimeoutError'
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(timeout)
    const result = await testAdoConnection(input(), { fetchFn, timeoutMs: 5_000 })
    expect(result).toEqual({ ok: false, error: 'Azure DevOps did not answer within 5s.' })
  })

  test('rejects blank org URL or PAT without any network call', async () => {
    const fetchFn = vi.fn<typeof fetch>()
    expect(await testAdoConnection(input({ orgUrl: ' ' }), { fetchFn })).toEqual({
      ok: false,
      error: 'Organization URL and PAT are both required.'
    })
    expect(await testAdoConnection(input({ pat: '' }), { fetchFn })).toEqual({
      ok: false,
      error: 'Organization URL and PAT are both required.'
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
