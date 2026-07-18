import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { Project } from '@common/domain'
import { ProjectsPaneBody } from './ProjectsPane'

// Vitest transforms TSX without the renderer's Vite React plugin, so provide its classic JSX
// runtime explicitly for the imported production component.
vi.stubGlobal('React', React)

vi.mock('../ipc')

function project(partial: Partial<Project> & Pick<Project, 'id'>): Project {
  return {
    name: partial.id,
    sortOrder: 0,
    archived: false,
    repoPaths: [`/repos/${partial.id}`],
    jiraJql: null,
    jiraBoardUrl: null,
    adoRepositories: [],
    togglProjectId: null,
    ...partial
  }
}

function render(
  status: 'idle' | 'loading' | 'ready' | 'error',
  projects: Project[]
): HTMLDivElement {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(
    React.createElement(ProjectsPaneBody, { status, projects })
  )
  return host
}

describe('ProjectsPane', () => {
  test('renders every project with bindings, reorder, archive and delete controls', () => {
    const host = render('ready', [
      project({
        id: 'p1',
        name: 'SPOT',
        repoPaths: ['/repos/spot', '/repos/spot-backend'],
        jiraJql: 'project = FID2507',
        adoRepositories: ['spot-backend'],
        togglProjectId: 42
      }),
      project({ id: 'p2', name: 'Archived one', archived: true })
    ])

    expect(host.querySelector<HTMLInputElement>('#ix-proj-name-p1')?.value).toBe('SPOT')
    expect(host.querySelector<HTMLInputElement>('#ix-proj-jql-p1')?.value).toBe(
      'project = FID2507'
    )
    expect(host.querySelector<HTMLInputElement>('#ix-proj-ado-p1')?.value).toBe('spot-backend')
    expect(host.querySelector<HTMLInputElement>('#ix-proj-toggl-p1')?.value).toBe('42')
    expect([...host.querySelectorAll('.ix-proj__path')].map((el) => el.textContent)).toEqual([
      '/repos/spot',
      '/repos/spot-backend',
      '/repos/p2'
    ])
    // The sole binding of a project cannot be removed.
    const removeButtons = [...host.querySelectorAll<HTMLButtonElement>('button')].filter((b) =>
      b.getAttribute('aria-label')?.startsWith('Odebrat složku')
    )
    expect(removeButtons.map((b) => b.disabled)).toEqual([false, false, true])
    // An archived project is dimmed and offers restore instead of archive.
    expect(host.querySelector('.ix-proj--archived')).toBeTruthy()
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(labels).toContain('Obnovit')
    expect(labels).toContain('Archivovat')
    expect(labels).toContain('Nový projekt (vybrat složku)')
    // Reorder controls disable at the boundaries.
    const up = [...host.querySelectorAll<HTMLButtonElement>('button')].filter((b) =>
      b.getAttribute('aria-label')?.startsWith('Posunout')
    )
    expect(up.map((b) => b.disabled)).toEqual([true, false, false, true])
  })

  test('renders the load failure state', () => {
    const host = render('error', [])
    expect(host.querySelector('.ix-proj__error')?.textContent).toContain('nepodařilo')
  })
})
