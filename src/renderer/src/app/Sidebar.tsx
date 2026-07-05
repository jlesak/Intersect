import { getSidebarSections } from '@renderer/shared/registries/sidebarRegistry'

/** The app sidebar: wordmark plus every registered section (workspaces today). */
export function Sidebar() {
  const sections = getSidebarSections()
  return (
    <aside className="jv-sidebar">
      <div className="jv-wordmark">
        <span className="jv-wordmark__dot" />
        <span className="jv-wordmark__name">Jarvis</span>
      </div>
      {sections.map((section) => {
        const Section = section.component
        return <Section key={section.id} />
      })}
    </aside>
  )
}
