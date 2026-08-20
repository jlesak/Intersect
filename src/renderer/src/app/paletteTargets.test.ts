import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { PullRequest, SessionSummary, Workspace } from '@common/domain'
import { filterCommands, useCommandPaletteStore } from '@renderer/features/commandPalette'
import { usePrInboxStore } from '@renderer/features/prInbox'
import { useSessionsStore } from '@renderer/features/sessions'
import { useWorkspacesStore } from '@renderer/features/workspaces'
import {
  __resetCommandRegistryForTests,
  getProvidedCommands
} from '@renderer/shared/registries/commandRegistry'
import { registerPaletteTargets } from './paletteTargets'
import { useShellStore } from './shellStore'

const workspace = (id: string, over: Partial<Workspace> = {}): Workspace => ({
  id,
  name: `Workspace ${id}`,
  folderPath: `/repos/${id}`,
  layout: 'single',
  activeTabId: null,
  sortOrder: 0,
  projectId: null,
  projectSource: 'auto',
  ...over
})

const session = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  filePath: `/p/${id}.jsonl`,
  cwd: '/repos/api',
  folderName: 'api',
  title: `Session ${id}`,
  gitBranch: null,
  firstTimestamp: 0,
  lastTimestamp: 0,
  durationMs: 0,
  activeDurationMs: 0,
  messageCount: 0,
  userPrompts: [],
  ...over
})

const pr = (prId: number): PullRequest =>
  ({
    prId,
    repositoryId: 'repo-1',
    repositoryName: 'api',
    projectId: 'proj',
    title: `Pull request ${prId}`,
    description: '',
    authorId: 'a',
    authorName: 'Marek K.',
    createdAt: 0,
    status: 'active',
    sourceRefName: 'refs/heads/f',
    targetRefName: 'refs/heads/main',
    sourceCommitId: '',
    targetCommitId: '',
    url: '',
    role: 'reviewer',
    myVote: null,
    myReviewerId: null,
    reviewers: [],
    newChangesSinceMyReview: false,
    activeThreadCount: 0,
    lastActivityAt: 0
  }) satisfies PullRequest

const ids = (query: string): string[] => getProvidedCommands(query).map((c) => c.id)

/** The ids the palette would actually show for a query, provider output ranked by the matcher. */
const matchedIds = (query: string): string[] =>
  filterCommands(query, getProvidedCommands(query)).map((c) => c.id)

// The palette-open listener is module-global; without dropping it the previous test's copy keeps
// firing and every count in this file drifts upward.
let unwire: (() => void) | undefined
const register = (): void => {
  unwire = registerPaletteTargets()
}

afterEach(() => {
  unwire?.()
  unwire = undefined
})

beforeEach(() => {
  __resetCommandRegistryForTests()
  useWorkspacesStore.setState({ byId: {}, order: [], selectedWorkspaceId: null }, false)
  usePrInboxStore.setState({ prsByKey: {}, order: [] }, false)
  useSessionsStore.setState({ all: [], status: 'idle', pendingResume: null }, false)
  useCommandPaletteStore.setState({ open: false }, false)
  useShellStore.setState({ context: null }, false)
  vi.restoreAllMocks()
})

describe('workspace targets', () => {
  test('every open workspace is offered, without anything being typed', () => {
    useWorkspacesStore.setState(
      { byId: { a: workspace('a'), b: workspace('b') }, order: ['a', 'b'] },
      false
    )
    register()
    expect(ids('')).toEqual(['workspaces.goto.a', 'workspaces.goto.b'])
  })

  test('a workspace answers to its folder’s name and not to the rest of its path', () => {
    useWorkspacesStore.setState(
      { byId: { a: workspace('a', { folderPath: '/Users/b/a/sh-things/proj' }) }, order: ['a'] },
      false
    )
    register()

    expect(matchedIds('bash')).toEqual([])
    expect(matchedIds('proj')).toEqual(['workspaces.goto.a'])
  })

  test('running one brings the shell to the workspace’s project, then selects it', () => {
    const select = vi.fn().mockResolvedValue(undefined)
    useWorkspacesStore.setState(
      { byId: { a: workspace('a', { projectId: 'proj-7' }) }, order: ['a'], select },
      false
    )
    register()

    void getProvidedCommands('')[0].handler()

    expect(useShellStore.getState().context).toEqual({ kind: 'project', id: 'proj-7' })
    expect(select).toHaveBeenCalledWith('a')
  })

  test('a workspace in no project lands in the Other bucket rather than a missing project', () => {
    const select = vi.fn().mockResolvedValue(undefined)
    useWorkspacesStore.setState(
      { byId: { a: workspace('a', { projectId: null }) }, order: ['a'], select },
      false
    )
    register()

    void getProvidedCommands('')[0].handler()

    expect(useShellStore.getState().context).toEqual({ kind: 'other' })
    expect(select).toHaveBeenCalledWith('a')
  })
})

describe('pull request targets', () => {
  test('a cached pull request is offered and opens on the PR section', () => {
    const openDetail = vi.fn().mockResolvedValue(undefined)
    usePrInboxStore.setState(
      { prsByKey: { 'repo-1:12': pr(12) }, order: ['repo-1:12'], openDetail },
      false
    )
    register()

    expect(ids('')).toEqual(['prInbox.open.repo-1.12'])
    void getProvidedCommands('')[0].handler()

    expect(useShellStore.getState().context).toEqual({ kind: 'section', id: 'prInbox' })
    expect(openDetail).toHaveBeenCalledWith('repo-1', 12)
  })
})

describe('session targets', () => {
  test('the history stays out of the way until the query is worth answering', () => {
    useSessionsStore.setState({ all: [session('s1')], status: 'ready' }, false)
    register()

    expect(ids('')).toEqual([])
    expect(ids('f')).toEqual([])
    expect(ids('fi')).toEqual(['sessions.resume.s1'])
  })

  test('running one records the resume intent for the app layer to carry out', () => {
    const summary = session('s1')
    useSessionsStore.setState({ all: [summary], status: 'ready' }, false)
    register()

    void getProvidedCommands('fi')[0].handler()
    expect(useSessionsStore.getState().pendingResume).toBe(summary)
  })

  test('opening the palette indexes the history, so the first search can answer', () => {
    const hydrate = vi.fn().mockResolvedValue(undefined)
    useSessionsStore.setState({ status: 'idle', hydrate }, false)
    register()

    useCommandPaletteStore.getState().toggle()
    expect(hydrate).toHaveBeenCalledOnce()
  })

  test('an already indexed history is not rebuilt on every opening', () => {
    const hydrate = vi.fn().mockResolvedValue(undefined)
    useSessionsStore.setState({ status: 'ready', hydrate }, false)
    register()

    useCommandPaletteStore.getState().toggle()
    useCommandPaletteStore.getState().close()
    useCommandPaletteStore.getState().toggle()
    expect(hydrate).not.toHaveBeenCalled()
  })

  test('closing the palette is not an opening', () => {
    const hydrate = vi.fn().mockResolvedValue(undefined)
    useSessionsStore.setState({ status: 'idle', hydrate }, false)
    // Already open before the listener exists, so the only transition it can see is the close.
    useCommandPaletteStore.setState({ open: true }, false)
    register()

    useCommandPaletteStore.getState().close()
    expect(hydrate).not.toHaveBeenCalled()
  })
})
