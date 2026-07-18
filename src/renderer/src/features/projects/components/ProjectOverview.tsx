import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { indexOverrides, prOverrideKey, resolveJiraProject, resolvePrProject } from '@common/projectAssign'
import { useMyWorkStore } from '@renderer/features/myWork'
import { selectPrList, usePrInboxStore } from '@renderer/features/prInbox'
import { useWorkspacesStore, workspacesForProject } from '@renderer/features/workspaces'
import { useProjectsStore } from '../store'

/**
 * The Overview entry point of a project context: the project's bindings and what currently
 * resolves to it, so misassigned content is diagnosable at a glance. Bindings are edited in
 * Settings → Projekty; this surface is read-only on purpose.
 */
export function ProjectOverview({ projectId }: { projectId: string }) {
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId))
  const projects = useProjectsStore((s) => s.projects)
  const overrides = useProjectsStore((s) => s.overrides)
  const workspaces = useWorkspacesStore(useShallow((s) => workspacesForProject(s, projectId)))
  const issues = useMyWorkStore((s) => s.issues)
  const prs = usePrInboxStore(selectPrList)

  const counts = useMemo(() => {
    const index = indexOverrides(overrides)
    const issueCount = issues.filter((i) => {
      const o = index.get(`jira ${i.key}`)
      return (o ? o.projectId : resolveJiraProject(i.key, projects)) === projectId
    }).length
    const prCount = prs.filter((pr) => {
      const o = index.get(`pr ${prOverrideKey(pr.repositoryId, pr.prId)}`)
      return (o ? o.projectId : resolvePrProject(pr.repositoryName, projects)) === projectId
    }).length
    return { issueCount, prCount }
  }, [issues, prs, projects, overrides, projectId])

  if (!project) return null

  return (
    <div className="ix-ctx__panel ix-ctx__panel--pad">
      <div className="ix-ctx__group">
        <div className="ix-ctx__group-head">In this project</div>
        <p className="ix-ctx__hint">
          {workspaces.length} workspace{workspaces.length === 1 ? '' : 's'} · {counts.prCount} pull
          request{counts.prCount === 1 ? '' : 's'} · {counts.issueCount} Jira issue
          {counts.issueCount === 1 ? '' : 's'}
        </p>
      </div>

      <div className="ix-ctx__group">
        <div className="ix-ctx__group-head">Repository folders</div>
        {project.repoPaths.map((path) => (
          <p key={path} className="ix-ctx__hint" title={path}>
            {path}
          </p>
        ))}
      </div>

      <div className="ix-ctx__group">
        <div className="ix-ctx__group-head">Bindings</div>
        <p className="ix-ctx__hint">Jira filter: {project.jiraJql ?? 'none'}</p>
        <p className="ix-ctx__hint">Jira board: {project.jiraBoardUrl ?? 'none'}</p>
        <p className="ix-ctx__hint">
          ADO repositories:{' '}
          {project.adoRepositories.length > 0 ? project.adoRepositories.join(', ') : 'none'}
        </p>
        <p className="ix-ctx__hint">
          Toggl project: {project.togglProjectId !== null ? project.togglProjectId : 'none'}
        </p>
        <p className="ix-ctx__hint">Edit bindings in Settings → Projekty.</p>
      </div>
    </div>
  )
}
