import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { SessionSummary, Tab, Workspace } from '@common/domain'

/**
 * The cross-slice collaborators are stubbed so every way a resume can end - including the ones the
 * end-to-end test cannot provoke - is reachable here. What is under test is the wiring's own
 * judgement: what it tells the user, and whether the in-progress flag is always cleared.
 */
const workspaces = {
  selectedWorkspaceId: null as string | null,
  create: vi.fn((): Promise<Workspace | null> => Promise.resolve(null)),
  select: vi.fn((): Promise<void> => Promise.resolve())
}
const tabs = {
  workspaceId: null as string | null,
  createTab: vi.fn(async (): Promise<Tab | null> => null),
  renameTab: vi.fn(async () => {})
}
let workspaceList: Workspace[] = []

vi.mock('@renderer/features/tabs', () => ({ useTabsStore: { getState: () => tabs } }))
vi.mock('@renderer/features/workspaces', () => ({
  useWorkspacesStore: { getState: () => workspaces },
  selectWorkspaceList: () => workspaceList
}))
vi.mock('./attentionWiring', () => ({ revealWorkspaceContext: vi.fn() }))
vi.mock('./waitForTabsReady', () => ({ waitForTabsReady: async () => {} }))

import { useSessionsStore } from '@renderer/features/sessions'
import { useToastStore } from '@renderer/shared/ui/toast'
import { wireSessionResume } from './sessionResumeWiring'

const WORKSPACE: Workspace = {
  id: 'ws1',
  name: 'spot',
  folderPath: '/repos/spot',
  layout: 'single',
  activeTabId: null,
  sortOrder: 0,
  projectId: null,
  projectSource: 'auto'
}

const TAB = { id: 'tab1' } as Tab

const summary = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id: 's1',
    filePath: '/p/s1.jsonl',
    cwd: '/repos/spot',
    folderName: 'spot',
    title: 'Fix the sync',
    gitBranch: null,
    firstTimestamp: 0,
    lastTimestamp: 1,
    durationMs: 1,
    activeDurationMs: 1,
    messageCount: 2,
    userPrompts: [],
    ...over
  }) as SessionSummary

const messages = (): string[] => useToastStore.getState().toasts.map((t) => t.message)

/** Ask for a resume and let the wiring's promise chain settle. */
async function resume(s = summary()): Promise<void> {
  useSessionsStore.getState().requestResume(s)
  await vi.waitFor(() => expect(useSessionsStore.getState().resumingId).toBeNull())
}

let unwire: (() => void) | undefined

beforeEach(() => {
  unwire?.()
  vi.clearAllMocks()
  workspaceList = [WORKSPACE]
  workspaces.selectedWorkspaceId = 'ws1'
  workspaces.create.mockResolvedValue(null)
  tabs.workspaceId = 'ws1'
  tabs.createTab.mockResolvedValue(TAB)
  useSessionsStore.setState({ pendingResume: null, resumingId: null })
  useToastStore.setState({ toasts: [] })
  unwire = wireSessionResume()
})

describe('wireSessionResume', () => {
  test('opens a tab for the session and names it in the confirmation', async () => {
    await resume()
    expect(tabs.createTab).toHaveBeenCalledWith('claude', 's1')
    expect(tabs.renameTab).toHaveBeenCalledWith('tab1', 'Fix the sync')
    expect(messages()).toEqual(['Resumed Fix the sync'])
  })

  test('creates a workspace when the session folder has none', async () => {
    workspaceList = []
    workspaces.selectedWorkspaceId = null
    workspaces.create.mockResolvedValue(WORKSPACE)
    await resume()
    expect(workspaces.create).toHaveBeenCalledWith('/repos/spot')
    expect(workspaces.select).toHaveBeenCalledWith('ws1')
    expect(messages()).toEqual(['Resumed Fix the sync'])
  })

  test('says so when no workspace could be made for the folder', async () => {
    workspaceList = []
    workspaces.create.mockResolvedValue(null)
    await resume()
    expect(tabs.createTab).not.toHaveBeenCalled()
    expect(messages()).toEqual(['Could not resume this session'])
  })

  test('says so when the terminal could not be opened', async () => {
    tabs.createTab.mockResolvedValue(null)
    await resume()
    expect(messages()).toEqual(['Could not resume this session'])
  })

  test('says so when the workspace switch did not settle in time', async () => {
    // waitForTabsReady resolves on its own timeout, leaving the tabs store on another workspace.
    tabs.workspaceId = 'someone-else'
    await resume()
    expect(tabs.createTab).not.toHaveBeenCalled()
    expect(messages()).toEqual(['Could not resume this session'])
  })

  test('reports a thrown failure instead of leaving the action stuck', async () => {
    tabs.createTab.mockRejectedValue(new Error('pty refused'))
    await resume()
    expect(messages()).toEqual(['Could not resume this session: pty refused'])
    expect(useSessionsStore.getState().resumingId).toBeNull()
  })

  test('a second request while one is in flight is refused out loud, not dropped', async () => {
    let release: (t: Tab) => void = () => {}
    tabs.createTab.mockReturnValue(new Promise<Tab>((r) => (release = r)))

    useSessionsStore.getState().requestResume(summary())
    await vi.waitFor(() => expect(tabs.createTab).toHaveBeenCalledTimes(1))
    expect(useSessionsStore.getState().resumingId).toBe('s1')

    useSessionsStore.getState().requestResume(summary({ id: 's2', title: 'Other work' }))
    expect(messages()).toEqual(['Another session is still being resumed'])
    // The refused request must not have displaced the one actually running.
    expect(useSessionsStore.getState().resumingId).toBe('s1')
    expect(tabs.createTab).toHaveBeenCalledTimes(1)

    release(TAB)
    await vi.waitFor(() => expect(useSessionsStore.getState().resumingId).toBeNull())
    expect(messages()).toContain('Resumed Fix the sync')
  })

  test('a later resume still runs after an earlier one failed', async () => {
    tabs.createTab.mockResolvedValueOnce(null)
    await resume()
    tabs.createTab.mockResolvedValue(TAB)
    await resume(summary({ id: 's2', title: 'Other work' }))
    expect(messages()).toEqual(['Could not resume this session', 'Resumed Other work'])
  })
})
