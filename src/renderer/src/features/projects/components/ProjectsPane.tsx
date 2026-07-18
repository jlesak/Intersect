import { useEffect, useState } from 'react'
import type { Project } from '@common/domain'
import { useProjectsStore } from '../store'
import * as api from '../ipc'

/**
 * The Settings pane for inspecting and editing projects and their bindings. Deliberately plain:
 * a dense list of cards with commit-on-blur fields, no drag-and-drop, no decoration - it is an
 * admin surface, the daily project UX arrives with the project rail.
 */
export function ProjectsPane() {
  const projects = useProjectsStore((s) => s.projects)
  const status = useProjectsStore((s) => s.status)

  useEffect(() => {
    void useProjectsStore.getState().load()
  }, [])

  return <ProjectsPaneBody status={status} projects={projects} />
}

/** The pane's markup over explicit state, separated so tests can render any store state. */
export function ProjectsPaneBody({
  status,
  projects
}: {
  status: 'idle' | 'loading' | 'ready' | 'error'
  projects: Project[]
}) {
  const addProject = async (): Promise<void> => {
    const folder = await api.pickFolder()
    if (!folder) return
    const name = folder.split('/').filter(Boolean).pop() ?? 'project'
    await useProjectsStore.getState().create(name, folder)
  }

  return (
    <>
      <div className="ix-settings__title">Projekty</div>
      <div className="ix-set-row__hint ix-proj__intro">
        Projekt spojuje repo složky, Jira filtr, ADO repozitáře a Toggl projekt do jednoho
        kontextu. Smazání ani archivace nikdy nemaže složky na disku ani nic vzdáleného.
      </div>
      {status === 'error' && (
        <div className="ix-proj__error">Projekty se nepodařilo načíst.</div>
      )}
      {projects.map((project, index) => (
        <ProjectCard
          key={project.id}
          project={project}
          isFirst={index === 0}
          isLast={index === projects.length - 1}
        />
      ))}
      <button type="button" className="ix-btn ix-btn--primary" onClick={() => void addProject()}>
        Nový projekt (vybrat složku)
      </button>
    </>
  )
}

/** A text field that keeps local edits and commits once on blur or Enter. */
function CommitField({
  id,
  label,
  value,
  placeholder,
  onCommit
}: {
  id: string
  label: string
  value: string
  placeholder?: string
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  const commit = (): void => {
    if (draft !== value) onCommit(draft)
  }

  return (
    <div className="ix-set-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="ix-input"
        type="text"
        spellCheck={false}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
    </div>
  )
}

function ProjectCard({
  project,
  isFirst,
  isLast
}: {
  project: Project
  isFirst: boolean
  isLast: boolean
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const store = useProjectsStore.getState

  const addFolder = async (): Promise<void> => {
    const folder = await api.pickFolder()
    if (folder) await store().addRepoPath(project.id, folder)
  }

  return (
    <div className={`ix-proj${project.archived ? ' ix-proj--archived' : ''}`}>
      <div className="ix-proj__head">
        <CommitField
          id={`ix-proj-name-${project.id}`}
          label="Název"
          value={project.name}
          onCommit={(name) => void store().update(project.id, { name })}
        />
        <div className="ix-proj__actions">
          <button
            type="button"
            className="ix-btn"
            disabled={isFirst}
            aria-label={`Posunout ${project.name} nahoru`}
            onClick={() => void store().move(project.id, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="ix-btn"
            disabled={isLast}
            aria-label={`Posunout ${project.name} dolů`}
            onClick={() => void store().move(project.id, 1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="ix-btn"
            onClick={() => void store().setArchived(project.id, !project.archived)}
          >
            {project.archived ? 'Obnovit' : 'Archivovat'}
          </button>
          {confirmingDelete ? (
            <>
              <button
                type="button"
                className="ix-btn ix-btn--danger"
                onClick={() => void store().remove(project.id)}
              >
                Opravdu smazat
              </button>
              <button type="button" className="ix-btn" onClick={() => setConfirmingDelete(false)}>
                Zpět
              </button>
            </>
          ) : (
            <button type="button" className="ix-btn" onClick={() => setConfirmingDelete(true)}>
              Smazat
            </button>
          )}
        </div>
      </div>

      <div className="ix-proj__folders">
        <div className="ix-set-row__hint">Repo složky (terminály a worktrees se přiřazují podle nich)</div>
        {project.repoPaths.map((path) => (
          <div className="ix-proj__folder" key={path}>
            <span className="ix-proj__path">{path}</span>
            <button
              type="button"
              className="ix-btn"
              disabled={project.repoPaths.length === 1}
              aria-label={`Odebrat složku ${path}`}
              onClick={() => void store().removeRepoPath(project.id, path)}
            >
              Odebrat
            </button>
          </div>
        ))}
        <button type="button" className="ix-btn" onClick={() => void addFolder()}>
          Přidat složku
        </button>
      </div>

      <CommitField
        id={`ix-proj-jql-${project.id}`}
        label="Jira JQL filtr"
        value={project.jiraJql ?? ''}
        placeholder="project = FID2507"
        onCommit={(v) => void store().update(project.id, { jiraJql: v || null })}
      />
      <CommitField
        id={`ix-proj-board-${project.id}`}
        label="Jira board URL"
        value={project.jiraBoardUrl ?? ''}
        placeholder="https://jira…/RapidBoard.jspa?rapidView=…"
        onCommit={(v) => void store().update(project.id, { jiraBoardUrl: v || null })}
      />
      <CommitField
        id={`ix-proj-ado-${project.id}`}
        label="ADO repozitáře (oddělené čárkou)"
        value={project.adoRepositories.join(', ')}
        placeholder="spot-backend, spot-frontend"
        onCommit={(v) =>
          void store().update(project.id, {
            adoRepositories: v
              .split(',')
              .map((name) => name.trim())
              .filter((name) => name.length > 0)
          })
        }
      />
      <CommitField
        id={`ix-proj-toggl-${project.id}`}
        label="Toggl projekt ID"
        value={project.togglProjectId === null ? '' : String(project.togglProjectId)}
        placeholder="123456"
        onCommit={(v) => {
          const trimmed = v.trim()
          const parsed = trimmed === '' ? null : Number(trimmed)
          if (parsed !== null && !Number.isInteger(parsed)) return
          void store().update(project.id, { togglProjectId: parsed })
        }}
      />
    </div>
  )
}
