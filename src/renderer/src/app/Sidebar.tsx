import { getSidebarSections } from '@renderer/shared/registries/sidebarRegistry'
import { resolveActiveSection, useShellStore } from './shellStore'

/**
 * The app sidebar: wordmark, an icon rail with one button per registered section (the active one
 * highlighted), and below it only the active section's own rail component (not every section
 * stacked). Section resolution mirrors App.tsx via `resolveActiveSection`.
 */
export function Sidebar() {
  const sections = getSidebarSections()
  const activeSectionId = useShellStore((s) => s.activeSectionId)
  const setActiveSection = useShellStore((s) => s.setActiveSection)
  const active = resolveActiveSection(sections, activeSectionId)
  const Section = active?.component

  return (
    <aside className="ix-sidebar">
      <div className="ix-wordmark">
        <span className="ix-wordmark__dot" />
        <span className="ix-wordmark__name">Intersect</span>
      </div>

      <div className="ix-rail">
        {sections.map((section) => {
          const Icon = section.icon
          return (
            <button
              key={section.id}
              type="button"
              className={`ix-rail__btn${section.id === active?.id ? ' ix-rail__btn--active' : ''}`}
              onClick={() => setActiveSection(section.id)}
            >
              <Icon />
              <span className="ix-rail__label">{section.label}</span>
            </button>
          )
        })}
      </div>

      {Section && <Section key={active?.id} />}
    </aside>
  )
}
