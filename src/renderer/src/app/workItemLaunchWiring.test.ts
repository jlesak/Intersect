import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import type { NewWorkItemRef, Tab, Workspace } from '@common/domain'

/**
 * The workspaces and tabs slices are stubbed: what is under test is the wiring's own decision,
 * whether a recorded launch opens a tab or only brings its workspace forward.
 */
const workspaces = {
  selectedWorkspaceId: null as string | null,
  create: vi.fn(async (): Promise<Workspace | null> => null),
  select: vi.fn(async (): Promise<void> => {})
}
const tabs = {
  workspaceId: 'ws1' as string | null,
  createTab: vi.fn(async (): Promise<Tab | null> => ({ id: 'tab1' }) as Tab)
}
let workspaceList: Workspace[] = []

vi.mock('@renderer/features/tabs', () => ({
  useTabsStore: { getState: () => tabs, subscribe: () => () => {} }
}))
vi.mock('@renderer/features/workspaces', () => ({
  useWorkspacesStore: { getState: () => workspaces },
  selectWorkspaceList: () => workspaceList,
  selectSelectedWorkspace: () => undefined
}))
vi.mock('./attentionWiring', () => ({ revealWorkspaceContext: vi.fn() }))
vi.mock('./waitForTabsReady', () => ({ waitForTabsReady: async () => {} }))

import { useWorkItemsStore } from '@renderer/features/workItems'
import { revealWorkspaceContext } from './attentionWiring'
import { wireWorkItemLaunch } from './workItemLaunchWiring'

const WORKSPACE: Workspace = {
  id: 'ws1',
  name: 'intersect-app-pr501',
  folderPath: '/fix/intersect-app-pr501',
  layout: 'single',
  activeTabId: null,
  sortOrder: 0,
  projectId: null,
  projectSource: 'auto'
}

const REF: NewWorkItemRef = {
  source: 'ado-pr',
  externalKey: 'repo:501',
  projectId: null,
  snapshot: { key: '!501', title: 'Add rate limiting', type: 'pull-request' }
}

beforeAll(() => {
  wireWorkItemLaunch()
})

beforeEach(() => {
  vi.clearAllMocks()
  workspaceList = [WORKSPACE]
  workspaces.selectedWorkspaceId = 'ws1'
  tabs.workspaceId = 'ws1'
  useWorkItemsStore.setState({ hydrate: vi.fn(async () => {}) })
})

describe('executing a card launch', () => {
  test('opens a Claude tab carrying the work item in the folder’s workspace', async () => {
    useWorkItemsStore.getState().requestLaunch({ ref: REF, folderPath: WORKSPACE.folderPath })

    await vi.waitFor(() => expect(tabs.createTab).toHaveBeenCalledWith('claude', null, REF))
    expect(revealWorkspaceContext).toHaveBeenCalledWith('ws1')
  })

  test('a launch that only asks for the workspace brings it forward and opens no tab', async () => {
    useWorkItemsStore
      .getState()
      .requestLaunch({ ref: REF, folderPath: WORKSPACE.folderPath, openTab: false })

    await vi.waitFor(() => expect(revealWorkspaceContext).toHaveBeenCalledWith('ws1'))
    await new Promise((r) => setTimeout(r, 0))
    expect(tabs.createTab).not.toHaveBeenCalled()
  })
})
