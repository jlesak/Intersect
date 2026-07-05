import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Workspace } from '@common/domain'

vi.mock('./ipc')
import * as api from './ipc'
import { selectWorkspaceList, useWorkspacesStore } from './store'

const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({
  id,
  name: id,
  folderPath: `/${id}`,
  layout: 'single',
  activeTabId: null,
  sortOrder: 0,
  ...over
})

const mocked = vi.mocked(api)

beforeEach(() => {
  useWorkspacesStore.setState(
    { status: 'idle', error: null, byId: {}, order: [], selectedWorkspaceId: null },
    false
  )
  vi.clearAllMocks()
})

describe('workspacesStore', () => {
  test('hydrate loads workspaces and the selected id, then is ready', async () => {
    mocked.getState.mockResolvedValue({
      workspaces: [ws('a', { sortOrder: 0 }), ws('b', { sortOrder: 1 })],
      selectedWorkspaceId: 'b'
    })
    await useWorkspacesStore.getState().hydrate()
    const s = useWorkspacesStore.getState()
    expect(s.status).toBe('ready')
    expect(selectWorkspaceList(s).map((w) => w.id)).toEqual(['a', 'b'])
    expect(s.selectedWorkspaceId).toBe('b')
  })

  test('hydrate sets error status when the IPC call fails', async () => {
    mocked.getState.mockRejectedValue(new Error('db gone'))
    await useWorkspacesStore.getState().hydrate()
    expect(useWorkspacesStore.getState().status).toBe('error')
    expect(useWorkspacesStore.getState().error).toMatch(/db gone/)
  })

  test('create adds the workspace and selects it', async () => {
    mocked.create.mockResolvedValue(ws('a'))
    await useWorkspacesStore.getState().create('/a')
    const s = useWorkspacesStore.getState()
    expect(s.byId.a).toBeDefined()
    expect(s.order).toContain('a')
    expect(s.selectedWorkspaceId).toBe('a')
  })

  test('rename replaces the workspace with the canonical row', async () => {
    useWorkspacesStore.setState({ byId: { a: ws('a') }, order: ['a'] })
    mocked.rename.mockResolvedValue(ws('a', { name: 'Renamed' }))
    await useWorkspacesStore.getState().rename('a', 'Renamed')
    expect(useWorkspacesStore.getState().byId.a.name).toBe('Renamed')
  })

  test('remove drops the workspace and reselects the first remaining when it was selected', async () => {
    useWorkspacesStore.setState({
      byId: { a: ws('a'), b: ws('b') },
      order: ['a', 'b'],
      selectedWorkspaceId: 'a'
    })
    mocked.remove.mockResolvedValue(undefined)
    await useWorkspacesStore.getState().remove('a')
    const s = useWorkspacesStore.getState()
    expect(s.order).toEqual(['b'])
    expect(s.byId.a).toBeUndefined()
    expect(s.selectedWorkspaceId).toBe('b')
  })

  test('remove of a non-selected workspace keeps the selection', async () => {
    useWorkspacesStore.setState({
      byId: { a: ws('a'), b: ws('b') },
      order: ['a', 'b'],
      selectedWorkspaceId: 'a'
    })
    mocked.remove.mockResolvedValue(undefined)
    await useWorkspacesStore.getState().remove('b')
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('a')
  })

  test('removing the last workspace clears the selection', async () => {
    useWorkspacesStore.setState({ byId: { a: ws('a') }, order: ['a'], selectedWorkspaceId: 'a' })
    mocked.remove.mockResolvedValue(undefined)
    await useWorkspacesStore.getState().remove('a')
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBeNull()
  })

  test('select persists and updates the selected id', async () => {
    useWorkspacesStore.setState({ byId: { a: ws('a'), b: ws('b') }, order: ['a', 'b'] })
    mocked.setActive.mockResolvedValue(undefined)
    await useWorkspacesStore.getState().select('b')
    expect(mocked.setActive).toHaveBeenCalledWith('b')
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('b')
  })
})
