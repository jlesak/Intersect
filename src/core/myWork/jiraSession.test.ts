import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { readStorageStateSession, sessionFromStorageState } from './jiraSession'

const state = {
  cookies: [
    { name: 'JSESSIONID', value: 'abc', domain: 'jira.skoda.vwgroup.com' },
    { name: 'TS01585851', value: 'xyz', domain: '.jira.skoda.vwgroup.com' },
    { name: 'ATLAS', value: 'parent', domain: '.skoda.vwgroup.com' },
    { name: 'KEYCLOAK_SESSION', value: 'idp', domain: 'identity.skoda.vwgroup.com' }
  ]
}

describe('sessionFromStorageState', () => {
  test('builds the Cookie header from host and parent-domain cookies only', () => {
    const session = sessionFromStorageState(state)
    expect(session?.cookieHeader).toBe('JSESSIONID=abc; TS01585851=xyz; ATLAS=parent')
  })

  test('returns null when no cookie applies to the host', () => {
    expect(sessionFromStorageState({ cookies: [{ name: 'X', value: '1', domain: 'example.com' }] })).toBeNull()
    expect(sessionFromStorageState({})).toBeNull()
    expect(sessionFromStorageState(null)).toBeNull()
  })

  test('a cookie whose domain merely shares a suffix does not leak in', () => {
    // 'a.com' vs host ending '...a.com' must match on domain boundaries, not raw suffixes.
    const session = sessionFromStorageState(
      { cookies: [{ name: 'EVIL', value: '1', domain: 'roup.com' }] },
      'jira.skoda.vwgroup.com'
    )
    expect(session).toBeNull()
  })
})

describe('readStorageStateSession', () => {
  test('reads the session from the storage-state file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imw-session-test-'))
    const path = join(dir, 'storageState.json')
    await writeFile(path, JSON.stringify(state))
    const session = await readStorageStateSession(path)
    expect(session?.cookieHeader).toContain('JSESSIONID=abc')
  })

  test('a missing or unreadable file yields null (login needed)', async () => {
    expect(await readStorageStateSession('/nonexistent/storageState.json')).toBeNull()
    const dir = await mkdtemp(join(tmpdir(), 'imw-session-test-'))
    const path = join(dir, 'broken.json')
    await writeFile(path, 'not json')
    expect(await readStorageStateSession(path)).toBeNull()
  })
})
