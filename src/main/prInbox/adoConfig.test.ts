import { describe, expect, test } from 'vitest'
import type { AdoSettings } from '@common/domain'
import { resolveAdoServerConfig, resolveVoteCredentials } from './adoConfig'

const saved: AdoSettings = {
  orgUrl: 'https://devops.example.com/tfs/Collection',
  project: 'SPOT',
  repository: 'intersect-app',
  pat: 'saved-pat'
}

// Only the saved-settings branch is covered here: the file/env fallbacks read the real
// ~/.claude.json, so exercising them would couple the test to the developer's machine.
describe('resolveAdoServerConfig with saved settings', () => {
  test('saved settings win over everything else', () => {
    const config = resolveAdoServerConfig({ AZURE_DEVOPS_ORG_URL: 'https://env', AZURE_DEVOPS_PAT: 'env-pat' }, saved)
    expect(config.command).toBe('npx')
    expect(config.env).toEqual({
      AZURE_DEVOPS_AUTH_METHOD: 'pat',
      AZURE_DEVOPS_ORG_URL: saved.orgUrl,
      AZURE_DEVOPS_DEFAULT_PROJECT: saved.project,
      AZURE_DEVOPS_PAT: saved.pat
    })
  })

  test('saved settings missing the org URL or PAT do not take precedence', () => {
    const config = resolveAdoServerConfig(
      { AZURE_DEVOPS_ORG_URL: 'https://env', AZURE_DEVOPS_PAT: 'env-pat' },
      { ...saved, pat: '' }
    )
    expect(config.env.AZURE_DEVOPS_PAT).not.toBe('')
  })

  test('vote credentials come from the saved settings too', () => {
    expect(resolveVoteCredentials(saved)).toEqual({ orgUrl: saved.orgUrl, pat: saved.pat })
  })
})
