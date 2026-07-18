import { describe, expect, test } from 'vitest'
import { normalizeRemoteUrl, remoteMatchesRepoName, remotesMatch, repoNameFromUrl } from './worktreeMatch'

describe('normalizeRemoteUrl', () => {
  const canonical = 'devops.skoda.vwgroup.com/projects/skodaauto/spot/_git/spot-backend'

  test.each([
    ['https', 'https://devops.skoda.vwgroup.com/projects/SkodaAuto/SPOT/_git/spot-backend'],
    ['https + .git', 'https://devops.skoda.vwgroup.com/projects/SkodaAuto/SPOT/_git/spot-backend.git'],
    ['ssh + port', 'ssh://devops.skoda.vwgroup.com:22/projects/SkodaAuto/SPOT/_git/spot-backend'],
    ['pat embedded', 'https://user:ghp_secret@devops.skoda.vwgroup.com/projects/SkodaAuto/SPOT/_git/spot-backend'],
    ['user only', 'https://DZCUP4C@devops.skoda.vwgroup.com/projects/SkodaAuto/SPOT/_git/spot-backend'],
    ['trailing slash', 'https://devops.skoda.vwgroup.com/projects/SkodaAuto/SPOT/_git/spot-backend/']
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
        'https://devops.skoda.vwgroup.com/projects/SkodaAuto/SPOT/_git/spot-backend',
        'ssh://devops.skoda.vwgroup.com:22/projects/SkodaAuto/SPOT/_git/spot-backend.git'
      )
    ).toBe(true)
  })

  test('different repos do not match', () => {
    expect(
      remotesMatch(
        'https://devops.skoda.vwgroup.com/projects/SkodaAuto/SPOT/_git/spot-backend',
        'https://devops.skoda.vwgroup.com/projects/SkodaAuto/SPOT/_git/spot-frontend'
      )
    ).toBe(false)
  })
})

describe('repoNameFromUrl', () => {
  test('extracts the segment after _git/', () => {
    expect(repoNameFromUrl('https://devops.skoda.vwgroup.com/projects/SkodaAuto/SPOT/_git/spot-backend')).toBe(
      'spot-backend'
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
        'ssh://devops.skoda.vwgroup.com:22/projects/SkodaAuto/SPOT/_git/spot-backend',
        'spot-backend'
      )
    ).toBe(true)
  })
  test('does not match a different repo', () => {
    expect(
      remoteMatchesRepoName(
        'https://devops.skoda.vwgroup.com/projects/SkodaAuto/SPOT/_git/spot-backend',
        'spot-frontend'
      )
    ).toBe(false)
  })
})
