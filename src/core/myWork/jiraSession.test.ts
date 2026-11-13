import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { readStorageStateSession, sessionFromStorageState } from './jiraSession'

// Every call names the host, so the cookie rules are proven on a neutral domain tree.
const HOST = 'jira.example.com'

const state = {
  cookies: [
    { name: 'JSESSIONID', value: 'abc', domain: HOST },
    { name: 'TS01585851', value: 'xyz', domain: `.${HOST}` },
    { name: 'ATLAS', value: 'parent', domain: '.example.com' },
    { name: 'KEYCLOAK_SESSION', value: 'idp', domain: 'identity.example.com' }
  ]
}

describe('sessionFromStorageState', () => {
  test('builds the Cookie header from host and parent-domain cookies only', () => {
    const session = sessionFromStorageState(state, HOST)
    expect(session?.cookieHeader).toBe('JSESSIONID=abc; TS01585851=xyz; ATLAS=parent')
  })

  test('returns null when no cookie applies to the host', () => {
    expect(sessionFromStorageState({ cookies: [{ name: 'X', value: '1', domain: 'unrelated.test' }] }, HOST))
      .toBeNull()
    expect(sessionFromStorageState({}, HOST)).toBeNull()
    expect(sessionFromStorageState(null, HOST)).toBeNull()
  })

  test('a cookie whose domain merely shares a suffix does not leak in', () => {
    // 'a.com' vs host ending '...a.com' must match on domain boundaries, not raw suffixes.
    const session = sessionFromStorageState(
      { cookies: [{ name: 'EVIL', value: '1', domain: 'ample.com' }] },
      HOST
    )
    expect(session).toBeNull()
  })
})

describe('readStorageStateSession', () => {
  test('reads the session from the storage-state file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imw-session-test-'))
    const path = join(dir, 'storageState.json')
    await writeFile(path, JSON.stringify(state))
    const session = await readStorageStateSession(path, HOST)
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
