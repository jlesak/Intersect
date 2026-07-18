import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Project } from '@common/domain'
import { projectStatus, useAttentionStore } from '@renderer/features/attention'
import { selectActiveProjects, useProjectsStore } from '@renderer/features/projects'
import { SidebarUsage } from '@renderer/features/usage'
import {
  selectSelectedWorkspace,
  useWorkspacesStore,
  workspacesForProject,
  WorkspaceList
} from '@renderer/features/workspaces'
import { getSidebarSections } from '@renderer/shared/registries/sidebarRegistry'
import { IconChevronLeft, IconChevronRight, IconLayers } from '@renderer/shared/ui/icons'
import { resolveShellContext, useShellStore, type ShellContext } from './shellStore'

/**
 * The app sidebar in the approved rail order: Dashboard on top, then the project pins (with an
 * aggregated session-status dot per project) and the virtual Other bucket, then the global
 * sections (People, TODO, Time, ...), with utility sections (Settings) pinned to the bottom.
 * Below the rail lives only the active context's own body: a project's workspace list, or the
 * active global section's panel. A collapse toggle shrinks everything to the icon rails alone.
 * Context resolution mirrors App.tsx via `resolveShellContext`.
 */
export function Sidebar() {
  const sections = getSidebarSections()
  const context = useShellStore((s) => s.context)
  const collapsed = useShellStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useShellStore((s) => s.toggleSidebar)
  const projects = useProjectsStore(useShallow(selectActiveProjects))
  const selectedWorkspace = useWorkspacesStore(selectSelectedWorkspace)

  // The rail owns project pins, so it also owns kicking off the projects load.
  useEffect(() => {
    void useProjectsStore.getState().load()
  }, [])

  const resolved = resolveShellContext(context, projects, sections, selectedWorkspace)
  const activeSectionId = resolved?.kind === 'section' ? resolved.id : null
  const activeSection = sections.find((s) => s.id === activeSectionId)
  const SectionBody = activeSection?.component

  const railSections = sections.filter((s) => (s.placement ?? 'rail') === 'rail')
  const aboveProjects = railSections.filter((s) => s.order < 0)
  const belowProjects = railSections.filter((s) => s.order >= 0)
  const footSections = sections.filter((s) => s.placement === 'footer')

  const railButton = (section: (typeof sections)[number]) => {
    const Icon = section.icon
    const Badge = section.badge
    return (
      <button
        key={section.id}
        type="button"
        className={`ix-rail__btn${section.prominent ? ' ix-rail__btn--primary' : ''}${section.id === activeSectionId ? ' ix-rail__btn--active' : ''}`}
        title={collapsed ? section.label : undefined}
        onClick={() => useShellStore.getState().setActiveSection(section.id)}
      >
        <Icon />
        <span className="ix-rail__label">{section.label}</span>
        {Badge && <Badge />}
      </button>
    )
  }

  return (
    <aside className="ix-sidebar">
      <div className="ix-wordmark">
        <span className="ix-wordmark__dot" />
        <span className="ix-wordmark__name">Intersect</span>
        <button
          type="button"
          className="ix-iconbtn ix-sidebar__collapse"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-pressed={collapsed}
          onClick={toggleSidebar}
        >
          {collapsed ? <IconChevronRight /> : <IconChevronLeft />}
        </button>
      </div>

      <div className="ix-rail">
        {aboveProjects.map(railButton)}
        {projects.map((p) => (
          <ProjectPin key={p.id} project={p} resolved={resolved} collapsed={collapsed} />
        ))}
        <OtherPin resolved={resolved} collapsed={collapsed} />
        {belowProjects.map(railButton)}
      </div>

      {!collapsed && resolved?.kind === 'project' && (
        <WorkspaceList key={resolved.id} projectScope={resolved.id} />
      )}
      {!collapsed && resolved?.kind === 'other' && <WorkspaceList key="other" projectScope={null} />}
      {!collapsed && resolved?.kind === 'section' && SectionBody && (
        <SectionBody key={activeSectionId} />
      )}

      {!collapsed && <SidebarUsage />}

      {footSections.length > 0 && <div className="ix-rail__foot">{footSections.map(railButton)}</div>}
    </aside>
  )
}

/** A project's rail pin: letter avatar, label, and the aggregated session-status dot. */
function ProjectPin({
  project,
  resolved,
  collapsed
}: {
  project: Project
  resolved: ShellContext | null
  collapsed: boolean
}) {
  const attention = useAttentionStore((s) => s.status)
  const workspaceIds = useWorkspacesStore(
    useShallow((s) => workspacesForProject(s, project.id).map((w) => w.id))
  )
  const status = projectStatus(attention, workspaceIds)
  const active = resolved?.kind === 'project' && resolved.id === project.id

  return (
    <button
      type="button"
      className={`ix-rail__btn ix-rail__btn--project${active ? ' ix-rail__btn--active' : ''}`}
      title={collapsed ? project.name : undefined}
      onClick={() => useShellStore.getState().setActiveProject(project.id)}
    >
      <span className="ix-rail__avatar" aria-hidden="true">
        {project.name.trim().charAt(0).toUpperCase() || '?'}
        {status && <span className={`ix-rail__dot ix-rail__dot--${status}`} />}
      </span>
      <span className="ix-rail__label">{project.name}</span>
    </button>
  )
}

/**
 * The virtual Other bucket's pin. Deliberately styled and positioned apart from real projects:
 * it cannot be pinned, reordered, or promoted - it only holds whatever nothing else matched.
 */
function OtherPin({ resolved, collapsed }: { resolved: ShellContext | null; collapsed: boolean }) {
  const attention = useAttentionStore((s) => s.status)
  const workspaceIds = useWorkspacesStore(
    useShallow((s) => workspacesForProject(s, null).map((w) => w.id))
  )
  const status = projectStatus(attention, workspaceIds)
  const active = resolved?.kind === 'other'

  return (
    <button
      type="button"
      className={`ix-rail__btn ix-rail__btn--other${active ? ' ix-rail__btn--active' : ''}`}
      title={collapsed ? 'Other' : undefined}
      onClick={() => useShellStore.getState().setOtherContext()}
    >
      <span className="ix-rail__avatar ix-rail__avatar--other" aria-hidden="true">
        <IconLayers />
        {status && <span className={`ix-rail__dot ix-rail__dot--${status}`} />}
      </span>
      <span className="ix-rail__label">Other</span>
    </button>
  )
}
