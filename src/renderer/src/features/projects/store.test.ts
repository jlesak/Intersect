import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Project } from '@common/domain'
import * as api from './ipc'
import { useProjectsStore } from './store'
import { reportError } from '@renderer/shared/ui/toast'

vi.mock('./ipc')
vi.mock('@renderer/shared/ui/toast')

const mocked = vi.mocked(api)

function project(id: string, sortOrder: number): Project {
  return {
    id,
    name: id.toUpperCase(),
    sortOrder,
    archived: false,
    repoPaths: [`/repos/${id}`],
    jiraJql: null,
    jiraBoardUrl: null,
    adoRepositories: [],
    togglProjectId: null
  }
}

function reset(): void {
  useProjectsStore.setState({ status: 'idle', error: null, projects: [] })
}

describe('projects store', () => {
  beforeEach(() => {
    reset()
    vi.clearAllMocks()
  })

  test('load hydrates the list and flips to ready', async () => {
    mocked.list.mockResolvedValue([project('a', 0)])
    await useProjectsStore.getState().load()
    const s = useProjectsStore.getState()
    expect(s.status).toBe('ready')
    expect(s.projects.map((p) => p.id)).toEqual(['a'])
  })

  test('a failed load reports the error state', async () => {
    mocked.list.mockRejectedValue(new Error('db gone'))
    await useProjectsStore.getState().load()
    const s = useProjectsStore.getState()
    expect(s.status).toBe('error')
    expect(s.error).toBe('db gone')
  })

  test('mutations delegate and re-read the canonical list', async () => {
    mocked.create.mockResolvedValue(project('a', 0))
    mocked.list.mockResolvedValue([project('a', 0)])
    await useProjectsStore.getState().create('A', '/repos/a')
    expect(mocked.create).toHaveBeenCalledWith('A', '/repos/a')
    expect(mocked.list).toHaveBeenCalledTimes(1)
    expect(useProjectsStore.getState().projects).toHaveLength(1)
  })

  test('a failed mutation surfaces a toast and still resyncs', async () => {
    mocked.update.mockRejectedValue(new Error('Project name must not be empty'))
    mocked.list.mockResolvedValue([project('a', 0)])
    await useProjectsStore.getState().update('a', { name: ' ' })
    expect(vi.mocked(reportError)).toHaveBeenCalledWith(
      'Could not save the project',
      expect.any(Error)
    )
    expect(useProjectsStore.getState().projects).toHaveLength(1)
  })

  test('move reorders by one position and persists the full permutation', async () => {
    useProjectsStore.setState({ projects: [project('a', 0), project('b', 1), project('c', 2)] })
    mocked.reorder.mockResolvedValue([])
    mocked.list.mockResolvedValue([])
    await useProjectsStore.getState().move('c', -1)
    expect(mocked.reorder).toHaveBeenCalledWith(['a', 'c', 'b'])
  })

  test('move at the boundary is a no-op', async () => {
    useProjectsStore.setState({ projects: [project('a', 0), project('b', 1)] })
    await useProjectsStore.getState().move('a', -1)
    await useProjectsStore.getState().move('b', 1)
    expect(mocked.reorder).not.toHaveBeenCalled()
  })
})
