import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { FixWorktreeClosedEvent, PullRequest, Workspace } from '@common/domain'

/** The preload bridge, reduced to the one push this wiring listens to. */
const bridge = vi.hoisted(() => ({
  closed: [] as ((event: FixWorktreeClosedEvent) => void)[]
}))
vi.mock('@renderer/shared/ipc/client', () => ({
  ipc: () => ({
    prInbox: {
      onFixWorktreeClosed: (cb: (event: FixWorktreeClosedEvent) => void) => {
        bridge.closed.push(cb)
        return () => {
          bridge.closed = bridge.closed.filter((c) => c !== cb)
        }
      }
    }
  })
}))

import { usePrInboxStore } from '@renderer/features/prInbox'
import { useWorkItemsStore } from '@renderer/features/workItems'
import { useWorkspacesStore } from '@renderer/features/workspaces'
import { useToastStore } from '@renderer/shared/ui/toast'
import { wirePrFix } from './prFixWiring'

const PR: PullRequest = {
  prId: 501,
  repositoryId: 'e2e-repo',
  repositoryName: 'intersect-app',
  projectId: 'SPOT',
  title: 'Add rate limiting',
  description: '',
  authorId: 'me',
  authorName: 'Jan Lesak',
  createdAt: 0,
  status: 'active',
  sourceRefName: 'refs/heads/feature/rate-limit',
  targetRefName: 'refs/heads/main',
  sourceCommitId: 's',
  targetCommitId: 't',
  url: 'u',
  role: 'author',
  myVote: null,
  myReviewerId: null,
  reviewers: [],
  newChangesSinceMyReview: false,
  activeThreadCount: 0,
  lastActivityAt: 0
}

const PATH = '/userdata/pr-fix-worktrees/intersect-app-pr501'

const ws = (id: string): Workspace => ({
  id,
  name: id,
  folderPath: `/${id}`,
  layout: 'single',
  activeTabId: null,
  sortOrder: 0,
  projectId: null,
  projectSource: 'auto'
})

const closedWith = (over: Partial<FixWorktreeClosedEvent>): void => {
  const event: FixWorktreeClosedEvent = {
    workspaceId: 'fix',
    path: PATH,
    outcome: 'removed',
    workspaceRemoved: true,
    detail: null,
    ...over
  }
  for (const cb of bridge.closed) cb(event)
}

const toasts = (): string[] => useToastStore.getState().toasts.map((t) => t.message)

let unwire: (() => void) | undefined

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
  useWorkItemsStore.setState({ pendingLaunch: null })
  usePrInboxStore.setState({ pendingFix: null })
  useWorkspacesStore.setState({
    byId: { fix: ws('fix'), other: ws('other') },
    order: ['fix', 'other'],
    selectedWorkspaceId: 'fix'
  })
  unwire = wirePrFix()
})

afterEach(() => {
  unwire?.()
})

describe('opening the fix tab', () => {
  test('a prepared fix launches a Claude tab on the PR in its worktree', () => {
    usePrInboxStore.setState({ pendingFix: { pr: PR, worktreePath: PATH, openTab: true } })

    expect(useWorkItemsStore.getState().pendingLaunch).toEqual({
      ref: {
        source: 'ado-pr',
        externalKey: 'e2e-repo:501',
        projectId: null,
        snapshot: { key: '!501', title: 'Add rate limiting', type: 'pull-request' }
      },
      folderPath: PATH,
      openTab: true
    })
    expect(usePrInboxStore.getState().pendingFix).toBeNull()
  })

  test('with a tab already open there, the launch only brings the workspace forward', () => {
    usePrInboxStore.setState({ pendingFix: { pr: PR, worktreePath: PATH, openTab: false } })
    expect(useWorkItemsStore.getState().pendingLaunch).toMatchObject({ openTab: false })
  })
})

describe('reporting how the cleanup ended', () => {
  test('a removed worktree takes its workspace out of the sidebar, quietly', () => {
    closedWith({ outcome: 'removed', workspaceRemoved: true })
    expect(useWorkspacesStore.getState().order).toEqual(['other'])
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('other')
    expect(toasts()).toEqual([])
  })

  test('a removed worktree whose workspace got a tab meanwhile asks to close those tabs', () => {
    closedWith({ outcome: 'removed', workspaceRemoved: false })
    expect(useWorkspacesStore.getState().order).toEqual(['fix', 'other'])
    expect(toasts()).toEqual([`Removed the worktree ${PATH}; close the tabs still open there.`])
  })

  test('uncommitted or untracked files keep the worktree, and the toast says how to retry', () => {
    closedWith({ outcome: 'dirty', workspaceRemoved: false, detail: '?? notes.txt' })
    expect(useWorkspacesStore.getState().order).toEqual(['fix', 'other'])
    expect(toasts()).toEqual([
      `Kept ${PATH}: it has uncommitted or untracked files. Commit or discard them, then close its last tab again.`
    ])
  })

  test('a session still running is named as the reason nothing was removed', () => {
    closedWith({ outcome: 'busy', workspaceRemoved: false })
    expect(toasts()).toEqual([
      `Kept ${PATH}: its Claude session was still running after 10 seconds. Open a tab there and close it again to retry.`
    ])
  })

  test('a git failure is passed on with what git said', () => {
    closedWith({ outcome: 'failed', workspaceRemoved: false, detail: 'fatal: permission denied' })
    expect(toasts()).toEqual([
      `Could not remove ${PATH}: fatal: permission denied. Delete the folder by hand before fixing this pull request again.`
    ])
  })
})
