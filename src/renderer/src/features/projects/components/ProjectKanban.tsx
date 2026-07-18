import { useEffect, useMemo, useState } from 'react'
import type { JiraIssue } from '@common/domain'
import { effectiveProject, indexOverrides, resolveJiraProject } from '@common/projectAssign'
import { JiraBoard, JiraBoardSkeleton, useMyWorkStore } from '@renderer/features/myWork'
import { ContextMenu, type MenuEntry } from '@renderer/shared/ui/ContextMenu'
import { IconRefresh } from '@renderer/shared/ui/icons'
import { selectActiveProjects, useProjectsStore } from '../store'

/**
 * The Kanban entry point of a project context: the My Work board narrowed to the issues this
 * project's Jira configuration selects (manual pins always win). The board data itself is the
 * global My Work fetch - this panel only assigns and filters, it never fetches per project.
 */
export function ProjectKanban({ projectId }: { projectId: string | null }) {
  const status = useMyWorkStore((s) => s.status)
  const error = useMyWorkStore((s) => s.error)
  const issues = useMyWorkStore((s) => s.issues)
  const projects = useProjectsStore((s) => s.projects)
  const overrides = useProjectsStore((s) => s.overrides)
  const [menu, setMenu] = useState<{ x: number; y: number; issue: JiraIssue } | null>(null)

  useEffect(() => {
    void useMyWorkStore.getState().hydrate()
  }, [])

  const filtered = useMemo(() => {
    const index = indexOverrides(overrides)
    return issues.filter(
      (issue) =>
        effectiveProject('jira', issue.key, resolveJiraProject(issue.key, projects), index) ===
        projectId
    )
  }, [issues, projects, overrides, projectId])

  const assignEntries = (issue: JiraIssue): MenuEntry[] => {
    const active = selectActiveProjects(useProjectsStore.getState())
    const hasOverride = overrides.some((o) => o.kind === 'jira' && o.key === issue.key)
    return [
      ...active
        .filter((p) => p.id !== projectId)
        .map((p) => ({
          label: `Assign to ${p.name}`,
          onClick: () => void useProjectsStore.getState().setOverride('jira', issue.key, p.id)
        })),
      ...(projectId !== null
        ? [
            {
              label: 'Assign to Other',
              onClick: () => void useProjectsStore.getState().setOverride('jira', issue.key, null)
            }
          ]
        : []),
      ...(hasOverride
        ? [
            {
              label: 'Assign automatically (by Jira project)',
              onClick: () => void useProjectsStore.getState().clearOverride('jira', issue.key)
            }
          ]
        : [])
    ]
  }

  if (status === 'idle' || status === 'loading') return <JiraBoardSkeleton />
  if (status === 'error' || status === 'login') {
    return (
      <div className="ix-empty">
        <span className="ix-eyebrow">Kanban</span>
        <div className="ix-empty__title">Board unavailable</div>
        <p className="ix-empty__hint">{error ?? 'Jira sign-in is required.'}</p>
        <button
          type="button"
          className="ix-btn"
          onClick={() => void useMyWorkStore.getState().refresh()}
        >
          <IconRefresh /> Retry
        </button>
      </div>
    )
  }

  if (filtered.length === 0) {
    return (
      <div className="ix-empty">
        <span className="ix-eyebrow">Kanban</span>
        <div className="ix-empty__title">No issues here</div>
        <p className="ix-empty__hint">
          {projectId === null
            ? 'Every fetched issue matched a project.'
            : 'No fetched issue matches this project’s Jira configuration.'}
        </p>
      </div>
    )
  }

  return (
    <div className="ix-ctx__panel">
      <JiraBoard
        issues={filtered}
        onIssueContextMenu={(issue, x, y) => setMenu({ x, y, issue })}
      />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          entries={assignEntries(menu.issue)}
        />
      )}
    </div>
  )
}
