import { SidebarUsage } from '@renderer/features/usage'
import { getSidebarSections } from '@renderer/shared/registries/sidebarRegistry'
import { IconChevronLeft, IconChevronRight } from '@renderer/shared/ui/icons'
import { resolveActiveSection, useShellStore } from './shellStore'

/**
 * The app sidebar: wordmark, a vertical icon rail with one button per registered section (the active
 * one highlighted), below it only the active section's own rail component (not every section
 * stacked), an always-visible Claude usage panel, and a bottom-pinned footer rail for utility
 * sections (Settings). A collapse toggle shrinks it to the icon rails alone - labels, wordmark
 * text, the section panel, and the usage panel are all hidden. Section resolution mirrors App.tsx
 * via `resolveActiveSection`.
 */
export function Sidebar() {
  const sections = getSidebarSections()
  const activeSectionId = useShellStore((s) => s.activeSectionId)
  const setActiveSection = useShellStore((s) => s.setActiveSection)
  const collapsed = useShellStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useShellStore((s) => s.toggleSidebar)
  const active = resolveActiveSection(sections, activeSectionId)
  const Section = active?.component
  const railSections = sections.filter((s) => (s.placement ?? 'rail') === 'rail')
  const footSections = sections.filter((s) => s.placement === 'footer')

  const railButton = (section: (typeof sections)[number]) => {
    const Icon = section.icon
    const Badge = section.badge
    return (
      <button
        key={section.id}
        type="button"
        className={`ix-rail__btn${section.prominent ? ' ix-rail__btn--primary' : ''}${section.id === active?.id ? ' ix-rail__btn--active' : ''}`}
        title={collapsed ? section.label : undefined}
        onClick={() => setActiveSection(section.id)}
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

      <div className="ix-rail">{railSections.map(railButton)}</div>

      {!collapsed && Section && <Section key={active?.id} />}

      {!collapsed && <SidebarUsage />}

      {footSections.length > 0 && <div className="ix-rail__foot">{footSections.map(railButton)}</div>}
    </aside>
  )
}
