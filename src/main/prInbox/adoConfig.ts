import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AdoSettings } from '@common/domain'

/** How to launch the Azure DevOps MCP server as a stdio subprocess. */
export interface AdoServerConfig {
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * Resolve the Azure DevOps MCP server launch config. Each connection field (org URL, project, PAT)
 * is resolved independently: a value the user saved in the app wins only when it is non-empty,
 * otherwise it comes live from the same fallback Claude Code uses - the global `~/.claude.json`
 * `mcpServers.azureDevOps` entry (command/args/env incl. the PAT), or `AZURE_DEVOPS_*` process env
 * if the file entry is absent. So saving only the repository never freezes the fallback PAT, and a
 * PAT rotated in `~/.claude.json` is picked up as long as the user has not saved their own.
 */
export function resolveAdoServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  saved?: AdoSettings | null
): AdoServerConfig {
  const savedOrgUrl = saved?.orgUrl?.trim() ?? ''
  const savedProject = saved?.project?.trim() ?? ''
  const savedPat = saved?.pat?.trim() ?? ''

  // Only consult the fallback when the saved settings leave a connection field blank, so a fully
  // saved connection stays self-contained (and its resolution never depends on the machine's
  // `~/.claude.json`).
  const fallback =
    savedOrgUrl && savedProject && savedPat ? null : resolveFallbackServerConfig(env)

  const orgUrl = savedOrgUrl || fallback?.env.AZURE_DEVOPS_ORG_URL || ''
  const project = savedProject || fallback?.env.AZURE_DEVOPS_DEFAULT_PROJECT || ''
  const pat = savedPat || fallback?.env.AZURE_DEVOPS_PAT || ''
  if (!orgUrl || !pat) {
    throw new Error(
      'Azure DevOps is not configured. Expected settings saved in the app, ' +
        'mcpServers.azureDevOps in ~/.claude.json, or ' +
        'AZURE_DEVOPS_ORG_URL + AZURE_DEVOPS_PAT in the environment.'
    )
  }

  // Keep the fallback's command/args/env (an on-prem file entry may use a custom launcher), then
  // overlay the effective identity so a per-field override still takes effect.
  const base = fallback ?? {
    command: 'npx',
    args: ['-y', '@tiberriver256/mcp-server-azure-devops'],
    env: {} as Record<string, string>
  }
  return {
    command: base.command,
    args: base.args,
    env: {
      ...base.env,
      AZURE_DEVOPS_AUTH_METHOD: base.env.AZURE_DEVOPS_AUTH_METHOD ?? env.AZURE_DEVOPS_AUTH_METHOD ?? 'pat',
      AZURE_DEVOPS_ORG_URL: orgUrl,
      AZURE_DEVOPS_DEFAULT_PROJECT: project,
      AZURE_DEVOPS_PAT: pat
    }
  }
}

/**
 * The fallback ADO server config Claude Code itself would use: the `~/.claude.json`
 * `mcpServers.azureDevOps` entry if present, else one constructed from `AZURE_DEVOPS_*` env.
 * Returns null when neither source carries an org URL + PAT.
 */
function resolveFallbackServerConfig(env: NodeJS.ProcessEnv): AdoServerConfig | null {
  const fromFile = readClaudeJsonAdoServer()
  if (fromFile) return fromFile

  const orgUrl = env.AZURE_DEVOPS_ORG_URL
  const pat = env.AZURE_DEVOPS_PAT
  if (!orgUrl || !pat) return null
  return {
    command: 'npx',
    args: ['-y', '@tiberriver256/mcp-server-azure-devops'],
    env: {
      AZURE_DEVOPS_AUTH_METHOD: env.AZURE_DEVOPS_AUTH_METHOD ?? 'pat',
      AZURE_DEVOPS_ORG_URL: orgUrl,
      AZURE_DEVOPS_DEFAULT_PROJECT: env.AZURE_DEVOPS_DEFAULT_PROJECT ?? '',
      AZURE_DEVOPS_PAT: pat
    }
  }
}

function readClaudeJsonAdoServer(): AdoServerConfig | null {
  try {
    const raw = readFileSync(join(homedir(), '.claude.json'), 'utf8')
    const parsed = JSON.parse(raw) as {
      mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>
    }
    const server = parsed.mcpServers?.azureDevOps
    if (!server?.command) return null
    return {
      command: server.command,
      args: server.args ?? [],
      env: { ...(server.env ?? {}) }
    }
  } catch {
    return null
  }
}

/**
 * Credentials for Intersect's own direct REST calls (vote casting). Read from the same MCP server
 * config the ADO client spawn uses, so a PAT still lives in exactly one place. Resolved lazily per
 * call, so a missing/rotated configuration surfaces on the vote, not at boot.
 */
export function resolveVoteCredentials(saved?: AdoSettings | null): { orgUrl: string; pat: string } {
  const env = resolveAdoServerConfig(process.env, saved).env
  const orgUrl = env.AZURE_DEVOPS_ORG_URL
  const pat = env.AZURE_DEVOPS_PAT
  if (!orgUrl || !pat) {
    throw new Error(
      'Azure DevOps voting is not configured. The azureDevOps MCP server entry must carry ' +
        'AZURE_DEVOPS_ORG_URL and AZURE_DEVOPS_PAT.'
    )
  }
  return { orgUrl, pat }
}

/**
 * Resolve who "I" am for filtering PRs. On-prem ADO Server has no get_me profile endpoint, so the
 * identity is taken from `INTERSECT_ADO_IDENTITY` (a UUID, a `domain\user` uniqueName, or a display
 * name); matching is then done client-side against creators/reviewers.
 */
export function resolveMyIdentity(env: NodeJS.ProcessEnv = process.env): {
  id?: string
  uniqueName?: string
  displayName?: string
} {
  const raw = env.INTERSECT_ADO_IDENTITY?.trim()
  if (!raw) {
    throw new Error(
      'Set INTERSECT_ADO_IDENTITY to your Azure DevOps identity (UUID, domain\\user, or display name) ' +
        'so Intersect can find the PRs you author or review.'
    )
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(raw)) return { id: raw }
  if (raw.includes('\\')) return { uniqueName: raw }
  return { displayName: raw }
}
