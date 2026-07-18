import { lazy, Suspense, useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  useWorkspacesStore,
  workspacesForProject,
  WorkspaceView
} from '@renderer/features/workspaces'
import {
  contextTab,
  OTHER_CONTEXT_KEY,
  PROJECT_TABS,
  useProjectContextStore,
  type ProjectTabId
} from '../contextStore'
import { useProjectsStore } from '../store'
import { ProjectWorktrees } from './ProjectWorktrees'

// The Kanban/PR/Overview panels transitively import the My Work and PR Inbox slices (and with
// them monaco). Loading them lazily keeps this file - and the projects barrel every other slice
// imports - light, and defers those chunks until a panel is actually opened.
const ProjectKanban = lazy(() =>
  import('./ProjectKanban').then((m) => ({ default: m.ProjectKanban }))
)
const ProjectPrList = lazy(() =>
  import('./ProjectPrList').then((m) => ({ default: m.ProjectPrList }))
)
const ProjectOverview = lazy(() =>
  import('./ProjectOverview').then((m) => ({ default: m.ProjectOverview }))
)

/** Which context the view renders: one project, or the virtual Other bucket. */
export type ProjectContext = { kind: 'project'; id: string } | { kind: 'other' }

const TAB_LABELS: Record<ProjectTabId, string> = {
  terminals: 'Terminals',
  kanban: 'Kanban',
  prs: 'Pull Requests',
  worktrees: 'Worktrees',
  overview: 'Overview'
}

/**
 * The main area of a project context: an entry-tab strip (Terminals is the daily default) over
 * the selected panel. Terminal identity is owned by the terminal slice's module-level session
 * map, so switching entry tabs or contexts detaches xterm DOM nodes without killing PTYs.
 * The Other bucket gets the same shell minus Worktrees/Overview (it has no bindings).
 */
export function ProjectContextView({ context }: { context: ProjectContext }) {
  const ctxKey = context.kind === 'project' ? context.id : OTHER_CONTEXT_KEY
  const scopeProjectId = context.kind === 'project' ? context.id : null

  const project = useProjectsStore((s) =>
    context.kind === 'project' ? s.projects.find((p) => p.id === context.id) : undefined
  )
  const scoped = useWorkspacesStore(useShallow((s) => workspacesForProject(s, scopeProjectId)))
  const wsStatus = useWorkspacesStore((s) => s.status)
  const selectedId = useWorkspacesStore((s) => s.selectedWorkspaceId)
  const tab = useProjectContextStore((s) => contextTab(s, ctxKey))
  const tabs: readonly ProjectTabId[] =
    context.kind === 'project'
      ? PROJECT_TABS
      : PROJECT_TABS.filter((t) => t !== 'worktrees' && t !== 'overview')
  const stripRef = useRef<HTMLDivElement>(null)

  // Entering a context restores its terminal spot: keep the global workspace selection inside
  // this context's scope, preferring the workspace it last showed.
  useEffect(() => {
    if (wsStatus !== 'ready') return
    if (selectedId && scoped.some((w) => w.id === selectedId)) {
      useProjectContextStore.getState().rememberWorkspace(ctxKey, selectedId)
      return
    }
    const remembered = useProjectContextStore.getState().lastWorkspace[ctxKey]
    const target = scoped.find((w) => w.id === remembered) ?? scoped[0]
    if (target) void useWorkspacesStore.getState().select(target.id)
  }, [ctxKey, scoped, selectedId, wsStatus])

  const onStripKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const idx = tabs.indexOf(tab)
    const next = tabs[(idx + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    useProjectContextStore.getState().setTab(ctxKey, next)
    stripRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()
  }

  if (context.kind === 'project' && !project) return <div className="ix-main" />

  const title = context.kind === 'project' ? project!.name : 'Other'

  return (
    <div className="ix-main">
      <div className="ix-ctx__head">
        <span className="ix-ctx__title" title={title}>
          {title}
        </span>
        {context.kind === 'other' && (
          <span className="ix-ctx__hint">Unassigned content - not a project</span>
        )}
        <div
          className="ix-ctx__tabs"
          role="tablist"
          aria-label={`${title} sections`}
          ref={stripRef}
          onKeyDown={onStripKeyDown}
        >
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              data-tab={t}
              aria-selected={t === tab}
              tabIndex={t === tab ? 0 : -1}
              className={`ix-ctx__tab${t === tab ? ' ix-ctx__tab--active' : ''}`}
              onClick={() => useProjectContextStore.getState().setTab(ctxKey, t)}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      {tab === 'terminals' && <WorkspaceView projectScope={scopeProjectId} />}
      <Suspense fallback={<div className="ix-ctx__panel" />}>
        {tab === 'kanban' && <ProjectKanban projectId={scopeProjectId} />}
        {tab === 'prs' && <ProjectPrList projectId={scopeProjectId} />}
        {tab === 'overview' && context.kind === 'project' && (
          <ProjectOverview projectId={context.id} />
        )}
      </Suspense>
      {tab === 'worktrees' && context.kind === 'project' && (
        <ProjectWorktrees projectId={context.id} />
      )}
    </div>
  )
}
