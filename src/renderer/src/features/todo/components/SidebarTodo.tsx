import { useState } from 'react'
import { dayKeyOf } from '@common/week'
import { useNow } from '@renderer/shared/ui/useNow'
import { isDueToday, isOverdue } from '../due'
import { useTodoStore, type TodoViewKey } from '../store'

const DAY_TICK_MS = 60_000

export function SidebarTodo() {
  const today = dayKeyOf(useNow(DAY_TICK_MS))
  const count = useTodoStore((s) => s.open.length)
  const overdue = useTodoStore(
    (s) => s.open.filter((t) => t.dueDay !== null && isOverdue(t.dueDay, today)).length
  )
  const dueToday = useTodoStore(
    (s) => s.open.filter((t) => t.dueDay !== null && isDueToday(t.dueDay, today)).length
  )
  const view = useTodoStore((s) => s.view)
  const projectId = useTodoStore((s) => s.activeProjectId)
  const filterId = useTodoStore((s) => s.activeFilterId)
  const projects = useTodoStore((s) => s.projects)
  const filters = useTodoStore((s) => s.filters)
  const [projectName, setProjectName] = useState('')
  const [addingProject, setAddingProject] = useState(false)
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null)
  const [renamedProjectName, setRenamedProjectName] = useState('')

  const nav = (label: string, destination: TodoViewKey, id?: string): React.JSX.Element => (
    <button type="button" className={`ix-todo-nav__item${view === destination &&
      (destination === 'project' ? projectId === id : destination === 'filter' ? filterId === id : true)
      ? ' ix-todo-nav__item--active' : ''}`}
    onClick={() => useTodoStore.getState().setView(destination, id)}>{label}</button>
  )
  return (
    <div className="ix-sidebar__body">
      <div className="ix-sidebar__section"><span className="ix-eyebrow">
        {count} open {count === 1 ? 'task' : 'tasks'}
      </span></div>
      {(overdue > 0 || dueToday > 0) && <div className="ix-todo-rail__due">
        {overdue > 0 && <span className="ix-todo-rail__due-line ix-todo-rail__due-line--overdue">
          {overdue} overdue</span>}
        {dueToday > 0 && <span className="ix-todo-rail__due-line">{dueToday} due today</span>}
      </div>}
      <div className="ix-sidebar__list ix-todo-nav">
        {nav('Today', 'today')}{nav('Upcoming', 'upcoming')}{nav('Inbox', 'inbox')}
        <div className="ix-todo-nav__heading">Projects
          <button type="button" title="New TODO project" onClick={() => setAddingProject(true)}>+</button>
        </div>
        {addingProject && <form onSubmit={(event) => {
          event.preventDefault()
          if (projectName.trim()) void useTodoStore.getState().createProject(projectName)
          setProjectName('')
          setAddingProject(false)
        }}><input className="ix-input" aria-label="Project name" autoFocus value={projectName}
          onChange={(event) => setProjectName(event.target.value)} /></form>}
        {projects.map((project) => <div className="ix-todo-nav__row" key={project.id}>
          {renamingProjectId === project.id ? <form className="ix-todo-nav__rename" onSubmit={(event) => {
            event.preventDefault()
            if (!renamedProjectName.trim()) return
            void useTodoStore.getState().updateProject(project.id, renamedProjectName)
            setRenamingProjectId(null)
          }}><input className="ix-input" aria-label="Rename project" autoFocus
            value={renamedProjectName} onChange={(event) => setRenamedProjectName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') setRenamingProjectId(null) }} />
            <button type="submit" title="Save project name">Save</button>
            <button type="button" title="Cancel project rename" onClick={() =>
              setRenamingProjectId(null)}>Cancel</button></form> : <>
            {nav(project.name, 'project', project.id)}
            <button type="button" title={`Rename ${project.name}`} onClick={() => {
              setRenamingProjectId(project.id)
              setRenamedProjectName(project.name)
            }}>✎</button>
            <button type="button" title={`Delete ${project.name}`} onClick={() =>
              void useTodoStore.getState().removeProject(project.id)}>×</button>
          </>}
        </div>)}
        <div className="ix-todo-nav__heading">Saved filters</div>
        {filters.map((filter) => <div className="ix-todo-nav__row" key={filter.id}>
          {nav(filter.name, 'filter', filter.id)}
          <button type="button" title={`Delete filter ${filter.name}`} onClick={() =>
            void useTodoStore.getState().removeFilter(filter.id)}>×</button>
        </div>)}
      </div>
    </div>
  )
}
