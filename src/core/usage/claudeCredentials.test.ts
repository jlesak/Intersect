import { describe, expect, it, vi } from 'vitest'
import { parseAccessToken, readClaudeCredentials } from './claudeCredentials'

const NOW = 1787600000000

function credentials(oauth: Record<string, unknown>): string {
  return JSON.stringify({ claudeAiOauth: oauth, mcpOAuth: {} })
}

describe('parseAccessToken', () => {
  it('returns the access token of a live credential', () => {
    const raw = credentials({ accessToken: 'sk-live', expiresAt: NOW + 60_000 })
    expect(parseAccessToken(raw, NOW)).toBe('sk-live')
  })

  it('ignores the refresh token entirely, leaving renewal to Claude Code', () => {
    const raw = credentials({ accessToken: 'sk-live', refreshToken: 'sk-refresh', expiresAt: NOW + 1 })
    expect(parseAccessToken(raw, NOW)).toBe('sk-live')
  })

  it('returns null for an expired token', () => {
    const raw = credentials({ accessToken: 'sk-stale', expiresAt: NOW - 1 })
    expect(parseAccessToken(raw, NOW)).toBeNull()
  })

  it('accepts a credential that carries no expiry at all', () => {
    expect(parseAccessToken(credentials({ accessToken: 'sk-live' }), NOW)).toBe('sk-live')
  })

  it('returns null when the blob has no claudeAiOauth section', () => {
    expect(parseAccessToken(JSON.stringify({ mcpOAuth: {} }), NOW)).toBeNull()
  })

  it('returns null for an empty or non-string token', () => {
    expect(parseAccessToken(credentials({ accessToken: '' }), NOW)).toBeNull()
    expect(parseAccessToken(credentials({ accessToken: 42 }), NOW)).toBeNull()
  })

  it('returns null (never throws) for malformed or absent content', () => {
    expect(parseAccessToken('not json {{{', NOW)).toBeNull()
    expect(parseAccessToken('', NOW)).toBeNull()
    expect(parseAccessToken(null, NOW)).toBeNull()
  })
})

describe('readClaudeCredentials', () => {
  const FROM_FILE = credentials({ accessToken: 'sk-from-file' })
  const FROM_KEYCHAIN = credentials({ accessToken: 'sk-from-keychain' })

  it('prefers the Keychain on macOS, never touching the file', async () => {
    const readTextFile = vi.fn(async () => FROM_FILE)
    const raw = await readClaudeCredentials({
      platform: 'darwin',
      home: '/Users/someone',
      readKeychain: async () => FROM_KEYCHAIN,
      readTextFile
    })

    expect(raw).toBe(FROM_KEYCHAIN)
    expect(readTextFile).not.toHaveBeenCalled()
  })

  it('falls back to the credentials file when the Keychain read is denied', async () => {
    const readTextFile = vi.fn(async () => FROM_FILE)
    const raw = await readClaudeCredentials({
      platform: 'darwin',
      home: '/Users/someone',
      readKeychain: async () => null,
      readTextFile
    })

    expect(raw).toBe(FROM_FILE)
    expect(readTextFile).toHaveBeenCalledWith('/Users/someone/.claude/.credentials.json')
  })

  it('falls back to the file when the Keychain lookup itself throws', async () => {
    const raw = await readClaudeCredentials({
      platform: 'darwin',
      home: '/Users/someone',
      readKeychain: async () => {
        throw new Error('security: no such tool')
      },
      readTextFile: async () => FROM_FILE
    })

    expect(raw).toBe(FROM_FILE)
  })

  it('skips the Keychain entirely off macOS', async () => {
    const readKeychain = vi.fn(async () => FROM_KEYCHAIN)
    const raw = await readClaudeCredentials({
      platform: 'linux',
      home: '/home/someone',
      readKeychain,
      readTextFile: async () => FROM_FILE
    })

    expect(raw).toBe(FROM_FILE)
    expect(readKeychain).not.toHaveBeenCalled()
  })

  it('resolves null (never throws) when there is no file to read either', async () => {
    const raw = await readClaudeCredentials({
      platform: 'linux',
      home: '/home/someone',
      readKeychain: async () => null,
      readTextFile: async () => {
        throw new Error('ENOENT')
      }
    })

    expect(raw).toBeNull()
  })
})
