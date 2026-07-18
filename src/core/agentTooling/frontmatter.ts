/**
 * A minimal YAML-frontmatter reader shared by the skills and agents catalogs. It intentionally
 * does not pull in a full YAML parser: skill/agent frontmatter is read only for a handful of
 * single-line `key: value` fields (description, model, tools), so a tolerant hand-rolled reader
 * keeps the core dependency-free and its failure modes obvious.
 */

/**
 * Split a document into its frontmatter block and body. A block is recognized only when the
 * document opens with a `---` line and a later line is exactly `---`; anything else is treated as
 * all-body with empty frontmatter, so a file without frontmatter still parses cleanly.
 */
export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  if (!raw.startsWith('---')) return { frontmatter: '', body: raw }
  const lines = raw.split('\n')
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i
      break
    }
  }
  if (close === -1) return { frontmatter: '', body: raw }
  return {
    frontmatter: lines.slice(1, close).join('\n'),
    body: lines
      .slice(close + 1)
      .join('\n')
      .replace(/^\n+/, '')
  }
}

/**
 * Read one top-level `key:` field from a frontmatter block. Handles quoted and unquoted
 * single-line values, and accumulates indented continuation lines so a long folded description
 * survives intact. Returns an empty string when the key is absent.
 */
export function readFrontmatterField(frontmatter: string, key: string): string {
  const lines = frontmatter.split('\n')
  const prefix = `${key}:`
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || !line.startsWith(prefix)) continue
    let value = line.slice(prefix.length).trim()
    while (i + 1 < lines.length && lines[i + 1] && /^\s/.test(lines[i + 1] ?? '')) {
      value += ' ' + (lines[++i] ?? '').trim()
    }
    return stripQuotes(value)
  }
  return ''
}

/** Strip a single pair of matching surrounding quotes (single or double) from a scalar value. */
export function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}
