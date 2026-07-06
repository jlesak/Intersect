import { getSidebarSections } from '@renderer/shared/registries/sidebarRegistry'
import { IconChevronLeft, IconChevronRight } from '@renderer/shared/ui/icons'
import { resolveActiveSection, useShellStore } from './shellStore'

/**
 * The app sidebar: wordmark, a vertical icon rail with one button per registered section (the active
 * one highlighted), and below it only the active section's own rail component (not every section
 * stacked). A collapse toggle shrinks it to the icon rail alone - labels, wordmark text, and the
 * section panel are hidden. Section resolution mirrors App.tsx via `resolveActiveSection`.
 */
export function Sidebar() {
  const sections = getSidebarSections()
  const activeSectionId = useShellStore((s) => s.activeSectionId)
  const setActiveSection = useShellStore((s) => s.setActiveSection)
  const collapsed = useShellStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useShellStore((s) => s.toggleSidebar)
  const active = resolveActiveSection(sections, activeSectionId)
  const Section = active?.component

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
        {sections.map((section) => {
          const Icon = section.icon
          return (
            <button
              key={section.id}
              type="button"
              className={`ix-rail__btn${section.id === active?.id ? ' ix-rail__btn--active' : ''}`}
              title={collapsed ? section.label : undefined}
              onClick={() => setActiveSection(section.id)}
            >
              <Icon />
              <span className="ix-rail__label">{section.label}</span>
            </button>
          )
        })}
      </div>

      {!collapsed && Section && <Section key={active?.id} />}
    </aside>
  )
}
