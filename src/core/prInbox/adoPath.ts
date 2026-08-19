/**
 * Azure DevOps addresses repository files with one leading slash. Review agents commonly report
 * repo-relative paths without it, so normalize every draft anchor before comparing or publishing.
 */
export function normalizeAdoPath(filePath: string): string {
  const relative = filePath.trim().replace(/^\/+/, '')
  return relative ? `/${relative}` : ''
}
