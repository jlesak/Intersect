/**
 * Pure git-remote-URL matching, used to find the local clone (a Jarvis workspace folder) that
 * corresponds to a PR's Azure DevOps repository. Electron-free so it is unit-testable.
 */

/**
 * Reduce a git remote URL to a canonical `host/path` key, ignoring scheme, embedded credentials,
 * port, a trailing `.git`, and case. Handles the three forms ADO emits/accepts:
 *   https://user:pat@host/Project/_git/Repo
 *   ssh://host:22/Project/_git/Repo
 *   git@host:Project/_git/Repo
 */
export function normalizeRemoteUrl(url: string): string {
  let s = url.trim()

  // scp-like syntax: git@host:path  ->  host/path
  const scp = /^[^/@]+@([^:/]+):(.+)$/.exec(s)
  if (scp && !s.includes('://')) {
    s = `${scp[1]}/${scp[2]}`
  } else {
    // strip scheme
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    // strip embedded credentials (user or user:pass@)
    s = s.replace(/^[^/@]+@/, '')
  }

  // strip a port on the host segment (host:22/...)
  s = s.replace(/^([^/]+):\d+\//, '$1/')

  // drop trailing slashes and a trailing .git
  s = s.replace(/\/+$/, '')
  s = s.replace(/\.git$/i, '')

  return s.toLowerCase()
}

/** Whether two remote URLs point at the same repository. */
export function remotesMatch(a: string, b: string): boolean {
  return normalizeRemoteUrl(a) === normalizeRemoteUrl(b)
}

/** The repository name from a remote URL: the segment after `_git/`, else the last path segment. */
export function repoNameFromUrl(url: string): string {
  const norm = normalizeRemoteUrl(url)
  const git = norm.lastIndexOf('/_git/')
  const tail = git >= 0 ? norm.slice(git + '/_git/'.length) : norm
  return tail.split('/').pop() ?? tail
}

/** Whether a clone's origin URL is the repo with the given Azure DevOps name (case-insensitive). */
export function remoteMatchesRepoName(remoteUrl: string, repoName: string): boolean {
  return repoNameFromUrl(remoteUrl) === repoName.trim().toLowerCase()
}
