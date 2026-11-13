/**
 * The Jira issue key embedded in a git branch name, normalized to the canonical uppercase form
 * (e.g. `feature/proj9-611-slug` yields `PROJ9-611`), or null when the session has no branch
 * or the branch carries no key. Matches the first `<PROJECT>-<number>` shaped token,
 * case-insensitively; the project part needs at least two leading alphanumerics so plain
 * hyphenated words never qualify.
 */
export function issueKeyFromBranch(branch: string | null): string | null {
  if (!branch) return null
  const match = /[A-Za-z][A-Za-z0-9]+-\d+/.exec(branch)
  return match ? match[0].toUpperCase() : null
}
