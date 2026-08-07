import type { AdoFallback, AdoSettings, PullRequest } from './domain'

/**
 * The organisation URL Azure DevOps is actually addressed by: what the user saved, or the
 * `~/.claude.json` / environment fallback while that field is blank. Empty when neither supplies
 * one.
 */
export function effectiveAdoOrgUrl(ado: AdoSettings, fallback: AdoFallback): string {
  return ado.orgUrl.trim() || fallback.orgUrl.trim()
}

/**
 * Whether Azure DevOps has enough of a connection for anything to load, mirroring what the core
 * requires to spawn its client: an organisation URL and a token. Each may come from what the user
 * saved in the app or from the `~/.claude.json` / environment fallback, and a blank saved field
 * defers to that fallback rather than overriding it.
 *
 * Every surface that decides whether to reach for Azure DevOps asks this one question, so a board
 * that refuses to sync and a dashboard that says the source is not set up can never disagree about
 * what being connected means.
 */
export function hasAdoConnection(ado: AdoSettings, fallback: AdoFallback): boolean {
  const hasPat = ado.pat.trim() !== '' || fallback.hasPat
  return effectiveAdoOrgUrl(ado, fallback) !== '' && hasPat
}

/**
 * The page a human opens to read this pull request on Azure DevOps.
 *
 * Composed rather than taken from the server: the pull-request payload's own `url` addresses the
 * REST resource, which answers JSON and is useless to a person or to a chat message. The browsable
 * address is a function of the organisation the user configured plus the pull request's project,
 * repository and number, all of which the app already holds.
 *
 * Empty when any of those is missing, so a caller can offer nothing rather than a broken link.
 */
export function prWebUrl(
  orgUrl: string,
  pr: Pick<PullRequest, 'projectId' | 'repositoryName' | 'prId'>
): string {
  const base = orgUrl.trim().replace(/\/+$/, '')
  if (!base || !pr.projectId || !pr.repositoryName || !pr.prId) return ''
  return (
    `${base}/${encodeURIComponent(pr.projectId)}/_git/` +
    `${encodeURIComponent(pr.repositoryName)}/pullrequest/${pr.prId}`
  )
}
