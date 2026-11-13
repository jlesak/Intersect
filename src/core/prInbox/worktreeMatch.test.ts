import { describe, expect, test } from 'vitest'
import { normalizeRemoteUrl, remoteMatchesRepoName, remotesMatch, repoNameFromUrl } from './worktreeMatch'

describe('normalizeRemoteUrl', () => {
  const canonical = 'devops.example.com/projects/acme/example/_git/orders-backend'

  test.each([
    ['https', 'https://devops.example.com/projects/Acme/Example/_git/orders-backend'],
    ['https + .git', 'https://devops.example.com/projects/Acme/Example/_git/orders-backend.git'],
    ['ssh + port', 'ssh://devops.example.com:22/projects/Acme/Example/_git/orders-backend'],
    ['pat embedded', 'https://user:ghp_secret@devops.example.com/projects/Acme/Example/_git/orders-backend'],
    ['user only', 'https://USER1@devops.example.com/projects/Acme/Example/_git/orders-backend'],
    ['trailing slash', 'https://devops.example.com/projects/Acme/Example/_git/orders-backend/']
  ])('%s form normalizes to the canonical key', (_label, url) => {
    expect(normalizeRemoteUrl(url)).toBe(canonical)
  })

  test('scp-like git@host:path form', () => {
    expect(normalizeRemoteUrl('git@github.com:acme/widgets.git')).toBe('github.com/acme/widgets')
  })
})

describe('remotesMatch', () => {
  test('https and ssh forms of the same repo match', () => {
    expect(
      remotesMatch(
        'https://devops.example.com/projects/Acme/Example/_git/orders-backend',
        'ssh://devops.example.com:22/projects/Acme/Example/_git/orders-backend.git'
      )
    ).toBe(true)
  })

  test('different repos do not match', () => {
    expect(
      remotesMatch(
        'https://devops.example.com/projects/Acme/Example/_git/orders-backend',
        'https://devops.example.com/projects/Acme/Example/_git/orders-frontend'
      )
    ).toBe(false)
  })
})

describe('repoNameFromUrl', () => {
  test('extracts the segment after _git/', () => {
    expect(repoNameFromUrl('https://devops.example.com/projects/Acme/Example/_git/orders-backend')).toBe(
      'orders-backend'
    )
  })
  test('falls back to the last path segment', () => {
    expect(repoNameFromUrl('git@github.com:acme/widgets.git')).toBe('widgets')
  })
})

describe('remoteMatchesRepoName', () => {
  test('matches the clone origin to the ADO repo name case-insensitively', () => {
    expect(
      remoteMatchesRepoName(
        'ssh://devops.example.com:22/projects/Acme/Example/_git/orders-backend',
        'orders-backend'
      )
    ).toBe(true)
  })
  test('does not match a different repo', () => {
    expect(
      remoteMatchesRepoName(
        'https://devops.example.com/projects/Acme/Example/_git/orders-backend',
        'orders-frontend'
      )
    ).toBe(false)
  })
})
