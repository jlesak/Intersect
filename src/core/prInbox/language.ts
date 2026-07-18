/**
 * Minimal file-path -> Monaco language id map for diff syntax highlighting. Kept pure so both the
 * main process (populating FileDiff) and tests can use it; the renderer may refine via Monaco's own
 * registry, but this covers the common cases without importing monaco in the main process.
 */
const BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  cs: 'csharp',
  java: 'java',
  kt: 'kotlin',
  go: 'go',
  rs: 'rust',
  py: 'python',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  sh: 'shell',
  bash: 'shell',
  sql: 'sql'
}

const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile'
}

export function langFromPath(filePath: string): string {
  const name = filePath.split('/').pop()?.toLowerCase() ?? ''
  if (BY_NAME[name]) return BY_NAME[name]
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  return BY_EXT[ext] ?? 'plaintext'
}
