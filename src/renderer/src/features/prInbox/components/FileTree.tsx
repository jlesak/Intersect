import { useMemo, useState, type ReactNode } from 'react'
import type { PrChangeFile, PrThread } from '@common/domain'
import { isThreadUnresolved } from '@common/prBoard'
import { buildFileTree, fileCount, type TreeDir } from '../fileTree'

interface FileTreeProps {
  changes: PrChangeFile[]
  threads: PrThread[]
  activeFilePath: string | null
  onOpen(path: string): void
}

const TYPE_LETTER: Record<PrChangeFile['changeType'], string> = {
  add: 'A',
  edit: 'M',
  delete: 'D',
  rename: 'R'
}

/** Collapsible changed-files tree; everything starts expanded, a click on a directory toggles it. */
export function FileTree({ changes, threads, activeFilePath, onOpen }: FileTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const tree = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of threads) {
      if (t.filePath && !t.isSystem && isThreadUnresolved(t)) {
        counts.set(t.filePath, (counts.get(t.filePath) ?? 0) + 1)
      }
    }
    return buildFileTree(changes, counts)
  }, [changes, threads])

  const toggle = (path: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const renderDir = (dir: TreeDir, depth: number): ReactNode => {
    const isCollapsed = collapsed.has(dir.path)
    return (
      <div key={dir.path}>
        <button
          type="button"
          className="ix-tree__node ix-tree__node--dir"
          style={{ paddingLeft: 8 + depth * 14 }}
          data-testid="tree-dir"
          onClick={() => toggle(dir.path)}
        >
          <span className="ix-tree__arrow">{isCollapsed ? '▸' : '▾'}</span>
          <span className="ix-tree__label" title={dir.path}>
            {dir.label}
          </span>
          {isCollapsed && <span className="ix-tree__count">{fileCount(dir)}</span>}
        </button>
        {!isCollapsed && renderChildren(dir, depth + 1)}
      </div>
    )
  }

  const renderChildren = (dir: TreeDir, depth: number): ReactNode => (
    <>
      {dir.dirs.map((d) => renderDir(d, depth))}
      {dir.files.map((file) => (
        <button
          key={file.path}
          type="button"
          className={`ix-tree__node ix-tree__node--file${file.path === activeFilePath ? ' ix-tree__node--active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={file.path}
          data-testid="tree-file"
          onClick={() => onOpen(file.path)}
        >
          <span className={`ix-pr-file__type ix-pr-file__type--${file.changeType}`}>
            {TYPE_LETTER[file.changeType]}
          </span>
          <span className="ix-tree__label">{file.name}</span>
          {file.commentCount > 0 && <span className="ix-tree__count">💬 {file.commentCount}</span>}
        </button>
      ))}
    </>
  )

  if (changes.length === 0) return <span className="ix-faint">No changes.</span>
  return <div className="ix-tree">{renderChildren(tree, 0)}</div>
}
