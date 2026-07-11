import type { PrChangeFile } from '@common/domain'

export interface TreeFile {
  path: string
  name: string
  changeType: PrChangeFile['changeType']
  /** Unresolved comment threads anchored to this file. */
  commentCount: number
}

/** A directory node; `label` may span several path segments when the chain had single children. */
export interface TreeDir {
  path: string
  label: string
  dirs: TreeDir[]
  files: TreeFile[]
}

interface MutableDir {
  path: string
  label: string
  dirs: Map<string, MutableDir>
  files: TreeFile[]
}

/**
 * Build the changed-files tree ADO-style: nested directories with single-child chains compacted
 * into one row, directories first, everything sorted alphabetically.
 */
export function buildFileTree(
  changes: PrChangeFile[],
  commentCounts: Map<string, number>
): TreeDir {
  const root: MutableDir = { path: '', label: '', dirs: new Map(), files: [] }
  for (const change of changes) {
    const segments = change.path.split('/').filter(Boolean)
    const name = segments.pop() ?? change.path
    let node = root
    let path = ''
    for (const seg of segments) {
      path = `${path}/${seg}`
      let child = node.dirs.get(seg)
      if (!child) {
        child = { path, label: seg, dirs: new Map(), files: [] }
        node.dirs.set(seg, child)
      }
      node = child
    }
    node.files.push({
      path: change.path,
      name,
      changeType: change.changeType,
      commentCount: commentCounts.get(change.path) ?? 0
    })
  }
  return finalize(root)
}

function finalize(node: MutableDir): TreeDir {
  let dirs = [...node.dirs.values()].map(finalize)
  // Compact: a directory with exactly one subdirectory and no files merges into its child.
  dirs = dirs.map((d) => {
    let current = d
    while (current.dirs.length === 1 && current.files.length === 0) {
      const only = current.dirs[0]
      current = { ...only, label: `${current.label}/${only.label}` }
    }
    return current
  })
  dirs.sort((a, b) => a.label.localeCompare(b.label))
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name))
  return { path: node.path, label: node.label, dirs, files }
}

/** Total files under the directory, recursively (shown on a collapsed directory). */
export function fileCount(dir: TreeDir): number {
  return dir.files.length + dir.dirs.reduce((sum, d) => sum + fileCount(d), 0)
}
