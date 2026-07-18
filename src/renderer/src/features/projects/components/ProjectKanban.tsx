import { useEffect, useMemo, useState } from 'react'
import type { JiraIssue } from '@common/domain'
import { effectiveProject, indexOverrides, resolveJiraProject } from '@common/projectAssign'
import {
  JiraBoard,
  JiraBoardSkeleton,
  useMyWorkStore,
  useProjectBoard
} from '@renderer/features/myWork'
import { ContextMenu, type MenuEntry } from '@renderer/shared/ui/ContextMenu'
import { IconRefresh } from '@renderer/shared/ui/icons'
import { selectActiveProjects, useProjectsStore } from '../store'

/**
 * The Kanban entry point of a project context. A project with its own Jira configuration (a JQL
 * filter or a board URL) gets its own directly synced board; without one, the panel narrows the
 * global My Work board to the issues assigned to this project (manual pins always win).
 */
export function ProjectKanban({ projectId }: { projectId: string | null }) {
  const project = useProjectsStore((s) =>
    projectId !== null ? s.projects.find((p) => p.id === projectId) : undefined
  )
  if (projectId !== null && project && (project.jiraJql || project.jiraBoardUrl)) {
    return <ProjectOwnBoard projectId={projectId} />
  }
  return <GlobalFilteredKanban projectId={projectId} />
}

/** A project's own board, served from the core's per-project Jira source. */
function ProjectOwnBoard({ projectId }: { projectId: string }) {
  const { board, refreshing, refresh } = useProjectBoard(projectId)

  if (board === null || (board.fetchedAt === null && board.error === null)) {
    return <JiraBoardSkeleton />
  }

  if (board.fetchedAt === null && board.error !== null) {
    const auth = board.error.kind === 'auth'
    return (
      <div className="ix-empty">
        <span className="ix-eyebrow">Kanban</span>
        <div className="ix-empty__title">Board unavailable</div>
        <p className="ix-empty__hint">{board.error.message}</p>
        <button
          type="button"
          className="ix-btn"
          onClick={() =>
            void (auth
              ? useMyWorkStore
                  .getState()
                  .loginAndRefresh()
                  .then(() => refresh())
              : refresh())
          }
        >
          <IconRefresh /> {auth ? 'Log in to Jira' : 'Retry'}
        </button>
      </div>
    )
  }

  const issues = board.issues.filter((issue) => !issue.absent)
  return (
    <div className="ix-ctx__panel">
      <div className="ix-ctx__toolbar" style={{ alignItems: 'center', gap: 10 }}>
        {board.error !== null && (
          <span className="ix-ctx__hint">Could not refresh: {board.error.message}</span>
        )}
        {board.partial && (
          <span className="ix-ctx__hint">Jira returned a partial result; issues may be missing.</span>
        )}
        <button type="button" className="ix-btn ix-btn--ghost" disabled={refreshing} onClick={refresh}>
          <IconRefresh /> Refresh
        </button>
      </div>
      {issues.length === 0 ? (
        <div className="ix-empty">
          <span className="ix-eyebrow">Kanban</span>
          <div className="ix-empty__title">No issues here</div>
          <p className="ix-empty__hint">The project’s Jira query returned no unresolved issues.</p>
        </div>
      ) : (
        <JiraBoard issues={issues} />
      )}
    </div>
  )
}

/** The global My Work board narrowed to this project's issues via bindings and manual pins. */
function GlobalFilteredKanban({ projectId }: { projectId: string | null }) {
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
