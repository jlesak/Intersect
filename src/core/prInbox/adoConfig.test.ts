import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AdoSettings } from '@common/domain'

// Control the `~/.claude.json` read per test. It defaults to a miss (ENOENT) so the file entry is
// deterministically absent and tests exercise the env fallback rather than the developer's/CI
// machine's real config; `mockClaudeJson` opts a test into a specific file entry.
const claudeJson = vi.hoisted(() => ({ read: (): string => { throw new Error('ENOENT') } }))
vi.mock('node:fs', () => ({
  readFileSync: (): string => claudeJson.read()
}))

function mockClaudeJson(mcpServers: Record<string, unknown>): void {
  claudeJson.read = (): string => JSON.stringify({ mcpServers })
}

afterEach(() => {
  claudeJson.read = (): string => {
    throw new Error('ENOENT')
  }
})

import { resolveAdoServerConfig, resolveVoteCredentials } from './adoConfig'

const saved: AdoSettings = {
  orgUrl: 'https://devops.example.com/tfs/Collection',
  project: 'SPOT',
  repository: 'intersect-app',
  pat: 'saved-pat'
}

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

// Per-field resolution: a blank saved field never freezes the fallback, so the app keeps following
// a rotated env/`~/.claude.json` credential until the user saves their own.
describe('resolveAdoServerConfig per-field fallback', () => {
  const env = {
    AZURE_DEVOPS_ORG_URL: 'https://env',
    AZURE_DEVOPS_PAT: 'env-pat',
    AZURE_DEVOPS_DEFAULT_PROJECT: 'ENVPROJ'
  }
  const repoOnly: AdoSettings = { orgUrl: '', project: '', repository: 'my-repo', pat: '' }

  test('saving only the repository leaves the org URL, project, and PAT on the live fallback', () => {
    const config = resolveAdoServerConfig(env, repoOnly)
    expect(config.env.AZURE_DEVOPS_ORG_URL).toBe('https://env')
    expect(config.env.AZURE_DEVOPS_DEFAULT_PROJECT).toBe('ENVPROJ')
    expect(config.env.AZURE_DEVOPS_PAT).toBe('env-pat')
  })

  test('a rotated fallback PAT is picked up while no PAT is saved', () => {
    expect(
      resolveAdoServerConfig({ ...env, AZURE_DEVOPS_PAT: 'pat-v1' }, repoOnly).env.AZURE_DEVOPS_PAT
    ).toBe('pat-v1')
    expect(
      resolveAdoServerConfig({ ...env, AZURE_DEVOPS_PAT: 'pat-v2' }, repoOnly).env.AZURE_DEVOPS_PAT
    ).toBe('pat-v2')
  })

  test('an explicitly saved PAT still overrides the fallback, blank fields still track it', () => {
    const config = resolveAdoServerConfig(env, { ...repoOnly, pat: 'my-own-pat' })
    expect(config.env.AZURE_DEVOPS_PAT).toBe('my-own-pat')
    expect(config.env.AZURE_DEVOPS_ORG_URL).toBe('https://env')
  })

  test('throws when neither the saved fields nor the fallback supply an org URL and PAT', () => {
    expect(() => resolveAdoServerConfig({}, repoOnly)).toThrow(/not configured/)
  })
})

// An on-prem/TFS `~/.claude.json` entry may launch a custom binary/wrapper; that launcher must
// survive no matter which identity fields the user saves, with only the identity env keys overlaid.
describe('resolveAdoServerConfig with a ~/.claude.json custom launcher', () => {
  const customLauncher = {
    command: '/opt/tools/ado-mcp',
    args: ['--stdio', '--tls-ca', '/etc/ssl/corp.pem'],
    env: {
      AZURE_DEVOPS_AUTH_METHOD: 'pat',
      AZURE_DEVOPS_ORG_URL: 'https://tfs.corp/tfs/Coll',
      AZURE_DEVOPS_DEFAULT_PROJECT: 'FILEPROJ',
      AZURE_DEVOPS_PAT: 'file-pat',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem'
    }
  }

  test('keeps the custom command/args and extra env even when org+project+pat are all saved', () => {
    mockClaudeJson({ azureDevOps: customLauncher })
    const config = resolveAdoServerConfig({}, saved)
    expect(config.command).toBe('/opt/tools/ado-mcp')
    expect(config.args).toEqual(['--stdio', '--tls-ca', '/etc/ssl/corp.pem'])
    expect(config.env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/corp.pem')
    expect(config.env.AZURE_DEVOPS_ORG_URL).toBe(saved.orgUrl)
    expect(config.env.AZURE_DEVOPS_DEFAULT_PROJECT).toBe(saved.project)
    expect(config.env.AZURE_DEVOPS_PAT).toBe(saved.pat)
  })

  test('empty saved fields fall back to the file entry env, not the default launcher', () => {
    mockClaudeJson({ azureDevOps: customLauncher })
    const config = resolveAdoServerConfig({}, { orgUrl: '', project: '', repository: 'r', pat: '' })
    expect(config.command).toBe('/opt/tools/ado-mcp')
    expect(config.env.AZURE_DEVOPS_ORG_URL).toBe('https://tfs.corp/tfs/Coll')
    expect(config.env.AZURE_DEVOPS_DEFAULT_PROJECT).toBe('FILEPROJ')
    expect(config.env.AZURE_DEVOPS_PAT).toBe('file-pat')
  })

  test('a rotated file-entry PAT is picked up while no PAT is saved', () => {
    mockClaudeJson({ azureDevOps: { ...customLauncher, env: { ...customLauncher.env, AZURE_DEVOPS_PAT: 'file-pat-v2' } } })
    const config = resolveAdoServerConfig({}, { orgUrl: '', project: '', repository: 'r', pat: '' })
    expect(config.env.AZURE_DEVOPS_PAT).toBe('file-pat-v2')
  })
})
