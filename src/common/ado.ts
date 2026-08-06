import type { AdoFallback, AdoSettings } from './domain'

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
  const orgUrl = ado.orgUrl.trim() || fallback.orgUrl.trim()
  const hasPat = ado.pat.trim() !== '' || fallback.hasPat
  return orgUrl !== '' && hasPat
}
