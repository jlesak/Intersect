import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { probeJiraSession } from './jiraProbe'

async function stateFile(content: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'imw-probe-test-'))
  const path = join(dir, 'storageState.json')
  await writeFile(path, JSON.stringify(content))
  return path
}

const jiraCookies = {
  cookies: [
    { name: 'JSESSIONID', value: 'abc', domain: 'jira.skoda.vwgroup.com' },
    { name: 'TS01585851', value: 'xyz', domain: '.jira.skoda.vwgroup.com' },
    { name: 'KEYCLOAK_SESSION', value: 'idp', domain: 'identity.skoda.vwgroup.com' }
  ]
}

function response(status: number, contentType = 'application/json'): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ 'content-type': contentType })
  } as Response
}

describe('probeJiraSession', () => {
  test('a missing state file needs login', async () => {
    expect(await probeJiraSession('/nonexistent/storageState.json')).toBe('auth')
  })

  test('a state file without cookies for the jira host needs login', async () => {
    const path = await stateFile({ cookies: [{ name: 'X', value: '1', domain: 'example.com' }] })
    expect(await probeJiraSession(path)).toBe('auth')
  })

  test('a 200 JSON answer means the session works, sending only jira-host cookies', async () => {
    const fetchFn = vi.fn(async () => response(200))
    const path = await stateFile(jiraCookies)
    expect(await probeJiraSession(path, fetchFn as unknown as typeof fetch)).toBe('ok')
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://jira.skoda.vwgroup.com/rest/api/2/myself')
    const cookie = (init.headers as Record<string, string>).Cookie
    expect(cookie).toContain('JSESSIONID=abc')
    expect(cookie).toContain('TS01585851=xyz')
    expect(cookie).not.toContain('KEYCLOAK_SESSION')
    expect(init.redirect).toBe('manual')
  })

  test.each([[301], [302], [401], [403]])('a %s answer needs login', async (status) => {
    const fetchFn = vi.fn(async () => response(status, 'text/html'))
    const path = await stateFile(jiraCookies)
    expect(await probeJiraSession(path, fetchFn as unknown as typeof fetch)).toBe('auth')
  })

  test('a network failure is inconclusive, never a forced login', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    const path = await stateFile(jiraCookies)
    expect(await probeJiraSession(path, fetchFn as unknown as typeof fetch)).toBe('unknown')
  })

  test('a 200 that is not JSON (an SSO interstitial) is inconclusive', async () => {
    const fetchFn = vi.fn(async () => response(200, 'text/html'))
    const path = await stateFile(jiraCookies)
    expect(await probeJiraSession(path, fetchFn as unknown as typeof fetch)).toBe('unknown')
  })
})
