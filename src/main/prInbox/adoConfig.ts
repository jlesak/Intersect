import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** How to launch the Azure DevOps MCP server as a stdio subprocess. */
export interface AdoServerConfig {
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * Resolve the Azure DevOps MCP server launch config the same way Claude Code does: from the global
 * `~/.claude.json` `mcpServers.azureDevOps` entry (command/args/env incl. the PAT). Falls back to
 * constructing it from `AZURE_DEVOPS_*` process env if the file entry is absent. Reusing the
 * existing configuration is decision #1 - Intersect hand-rolls no separate ADO client or PAT storage.
 */
export function resolveAdoServerConfig(env: NodeJS.ProcessEnv = process.env): AdoServerConfig {
  const fromFile = readClaudeJsonAdoServer()
  if (fromFile) return fromFile

  const orgUrl = env.AZURE_DEVOPS_ORG_URL
  const pat = env.AZURE_DEVOPS_PAT
  if (!orgUrl || !pat) {
    throw new Error(
      'Azure DevOps is not configured. Expected mcpServers.azureDevOps in ~/.claude.json or ' +
        'AZURE_DEVOPS_ORG_URL + AZURE_DEVOPS_PAT in the environment.'
    )
  }
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
export function resolveVoteCredentials(): { orgUrl: string; pat: string } {
  const env = resolveAdoServerConfig().env
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
