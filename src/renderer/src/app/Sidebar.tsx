import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Project } from '@common/domain'
import { projectStatus, useAttentionStore } from '@renderer/features/attention'
import { selectActiveProjects, useProjectsStore } from '@renderer/features/projects'
import { SidebarTimer } from '@renderer/features/timeTracking'
import { SidebarUsage } from '@renderer/features/usage'
import {
  selectSelectedWorkspace,
  useWorkspacesStore,
  workspacesForProject,
  WorkspaceList
} from '@renderer/features/workspaces'
import { SIDEBAR_PANEL_MIN } from '@common/domain'
import { getSidebarSections } from '@renderer/shared/registries/sidebarRegistry'
import { IconChevronLeft, IconChevronRight, IconLayers } from '@renderer/shared/ui/icons'
import { PanelResizer } from './PanelResizer'
import { useSidebarLayoutStore } from './sidebarLayout'
import { resolveShellContext, useShellStore, type ShellContext } from './shellStore'

/**
 * What a stacked panel must leave for everything else in the sidebar. Dragging one panel taller
 * than this simply makes the sidebar scroll (which it already does on a short window), but a drag
 * that could swallow the whole column would be a trap with no way back short of the reset.
 */
const ROOM_FOR_THE_REST = 160

/**
 * The app sidebar in the approved rail order: Dashboard on top, then the project pins (with an
 * aggregated session-status dot per project) and the virtual Other bucket, then the global
 * sections (1:1, TODO, Time, ...), with utility sections (Settings) pinned to the bottom.
 * Below the rail lives the active context's own body (a project's workspace list, or the active
 * global section's panel), then the running work timer and the Claude usage panel. A collapse toggle shrinks everything to the icon rails alone.
 * Context resolution mirrors App.tsx via `resolveShellContext`.
 *
 * The rail and the usage panel can each be dragged to a height, and the sidebar itself to a width;
 * the middle slot takes whatever is left. Until a divider is dragged, every panel sizes itself by
 * its content, exactly as it did before. A panel given a height scrolls inside it rather than
 * growing, so nothing here can paint over the controls above it (see `.ix-sidebar__body` in
 * app.css for why that guarantee is structural).
 */
export function Sidebar() {
  const sections = getSidebarSections()
  const context = useShellStore((s) => s.context)
  const collapsed = useShellStore((s) => s.sidebarCollapsed)
  const safeMode = useShellStore((s) => s.safeMode)
  const toggleSidebar = useShellStore((s) => s.toggleSidebar)
  const projects = useProjectsStore(useShallow(selectActiveProjects))
  const selectedWorkspace = useWorkspacesStore(selectSelectedWorkspace)
  const railHeight = useSidebarLayoutStore((s) => s.railHeight)
  const usageHeight = useSidebarLayoutStore((s) => s.usageHeight)
  const asideRef = useRef<HTMLElement>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const usageRef = useRef<HTMLDivElement>(null)

  // The ceiling a drag may not pass. Measured when the drag needs it, not stored: it is the live
  // window height, which a resize changes without telling this component.
  const roomFor = (): number =>
    Math.max(ROOM_FOR_THE_REST, (asideRef.current?.clientHeight ?? 0) - ROOM_FOR_THE_REST)

  // A panel that has never been dragged has no height of its own, so a drag has to start from what
  // it currently occupies on screen.
  const measured = (ref: React.RefObject<HTMLElement | null>, set: number | null): number =>
    set ?? ref.current?.getBoundingClientRect().height ?? 0

  // The rail owns project pins, so it also owns kicking off the projects load. Safe mode leaves
  // them unloaded, because the rail renders outside the shell's region boundary and a project row
  // the renderer cannot draw takes the whole window with it on every boot.
  //
  // The gate on the pins below is what holds that guarantee. The projects store is shared and any
  // other surface may fill it a tick later - Settings, the section safe mode lands on, opens on
  // its projects category and loads the rows from a mount effect - so the rail decides what it
  // draws from the flag itself, whoever filled the store.
  useEffect(() => {
    if (safeMode) return
    void useProjectsStore.getState().load()
  }, [safeMode])

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

  const layout = useSidebarLayoutStore.getState

  return (
    <aside className="ix-sidebar" ref={asideRef}>
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

      <div
        className="ix-rail"
        ref={railRef}
        style={railHeight === null ? undefined : { height: railHeight }}
      >
        {aboveProjects.map(railButton)}
        {!safeMode &&
          projects.map((p) => (
            <ProjectPin key={p.id} project={p} resolved={resolved} collapsed={collapsed} />
          ))}
        {!safeMode && <OtherPin resolved={resolved} collapsed={collapsed} />}
        {belowProjects.map(railButton)}
      </div>
      {!collapsed && (
        <PanelResizer
          orientation="horizontal"
          label="Section list height"
          testId="sidebar-rail-resizer"
          size={() => measured(railRef, railHeight)}
          min={SIDEBAR_PANEL_MIN}
          max={roomFor}
          onResize={(px) => layout().setRailHeight(px)}
          onReset={() => layout().setRailHeight(null)}
        />
      )}

      {/* The middle slot always exists, even when the active context draws nothing into it. It is
          what separates the divider above from the one below: with no element between them the two
          land on the same pixel, the lower one wins every press, and dragging the rail silently
          resized the usage panel instead. */}
      {!collapsed && (
        <div className="ix-sidebar__slot">
          {resolved?.kind === 'project' && (
            <WorkspaceList key={resolved.id} projectScope={resolved.id} />
          )}
          {resolved?.kind === 'other' && <WorkspaceList key="other" projectScope={null} />}
          {resolved?.kind === 'section' && SectionBody && <SectionBody key={activeSectionId} />}
        </div>
      )}

      {!collapsed && <SidebarTimer />}
      {!collapsed && (
        <PanelResizer
          orientation="horizontal"
          label="Usage panel height"
          testId="sidebar-usage-resizer"
          invert
          size={() => measured(usageRef, usageHeight)}
          min={SIDEBAR_PANEL_MIN}
          max={roomFor}
          onResize={(px) => layout().setUsageHeight(px)}
          onReset={() => layout().setUsageHeight(null)}
        />
      )}
      {!collapsed && (
        <div
          className="ix-sidebar__usage"
          ref={usageRef}
          style={usageHeight === null ? undefined : { height: usageHeight }}
        >
          <SidebarUsage />
        </div>
      )}

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
