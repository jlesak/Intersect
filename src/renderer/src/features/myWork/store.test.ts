import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { JiraBoardSnapshot, JiraIssueSnapshot } from '@common/domain'
import type { MyWorkChangedEvent } from '@common/ipc'

vi.mock('./ipc')
// The store fans a shared refresh out to the prInbox slice; stub its store so these tests stay
// isolated from that slice (and from the heavyweight components its barrel re-exports).
const prInboxSync = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@renderer/features/prInbox', () => ({
  usePrInboxStore: { getState: () => ({ sync: prInboxSync }) }
}))
import * as api from './ipc'
import { formatRelativeTime, groupByColumn, useMyWorkStore } from './store'

const issue = (key: string, over: Partial<JiraIssueSnapshot> = {}): JiraIssueSnapshot => ({
  key,
  url: `https://jira.skoda.vwgroup.com/browse/${key}`,
  summary: `Issue ${key}`,
  column: 'todo',
  priority: null,
  updatedAt: 1000,
  description: null,
  rawStatus: 'To Do',
  rawPriority: null,
  assignee: null,
  epicKey: null,
  epicSummary: null,
  estimateSeconds: null,
  components: [],
  fetchedAt: 1000,
  absent: false,
  ...over
})

const board = (over: Partial<JiraBoardSnapshot> = {}): JiraBoardSnapshot => ({
  sourceKey: 'global',
  issues: [],
  fetchedAt: 42,
  partial: false,
  error: null,
  ...over
})

const mocked = vi.mocked(api)

const reset = (over: Partial<ReturnType<typeof useMyWorkStore.getState>> = {}): void => {
  useMyWorkStore.setState(
    {
      status: 'idle',
      errorKind: null,
      error: null,
      partial: false,
      issues: [],
      fetchedAt: null,
      prSyncStarted: false,
      pendingPrOpen: null,
      ...over
    },
    false
  )
}

beforeEach(() => {
  reset()
  vi.clearAllMocks()
})

describe('groupByColumn', () => {
  test('groups issues per column with every column present', () => {
    const b = groupByColumn([
      issue('A-1', { column: 'progress' }),
      issue('A-2', { column: 'todo' }),
      issue('A-3', { column: 'progress' })
    ])
    expect(b.todo.map((i) => i.key)).toEqual(['A-2'])
    expect(b.progress.map((i) => i.key)).toEqual(['A-1', 'A-3'])
    expect(b.waiting).toEqual([])
    expect(b.review).toEqual([])
    expect(b.test).toEqual([])
  })

  test('sorts each column by last activity, newest first', () => {
    const b = groupByColumn([
      issue('A-1', { column: 'todo', updatedAt: 1 }),
      issue('A-3', { column: 'todo', updatedAt: 3 }),
      issue('A-2', { column: 'todo', updatedAt: 2 })
    ])
    expect(b.todo.map((i) => i.key)).toEqual(['A-3', 'A-2', 'A-1'])
  })
})

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-07-06T12:00:00Z')

  test.each([
    ['2026-07-06T11:59:40Z', 'just now'],
    ['2026-07-06T11:48:00Z', '12m ago'],
    ['2026-07-06T09:00:00Z', '3h ago'],
    ['2026-07-05T06:00:00Z', 'yesterday'],
    ['2026-07-02T12:00:00Z', '4d ago']
  ])('formats %s as %s', (ts, expected) => {
    expect(formatRelativeTime(Date.parse(ts), now)).toBe(expected)
  })

  test('a future timestamp clamps to just now', () => {
    expect(formatRelativeTime(now + 60_000, now)).toBe('just now')
  })
})

describe('store status transitions', () => {
  test('hydrate paints the cached board immediately and is ready', async () => {
    mocked.list.mockResolvedValue(board({ issues: [issue('A-1')], fetchedAt: 42 }))
    await useMyWorkStore.getState().hydrate()
    const s = useMyWorkStore.getState()
    expect(s.status).toBe('ready')
    expect(s.issues.map((i) => i.key)).toEqual(['A-1'])
    expect(s.fetchedAt).toBe(42)
  })

  test('a cold-start envelope (nothing fetched, no error) stays loading until the push lands', async () => {
    mocked.list.mockResolvedValue(board({ fetchedAt: null }))
    await useMyWorkStore.getState().hydrate()
    expect(useMyWorkStore.getState().status).toBe('loading')
  })

  test('issues marked absent are filtered from the shown board', async () => {
    mocked.list.mockResolvedValue(
      board({ issues: [issue('A-1'), issue('GONE-1', { absent: true })], fetchedAt: 42 })
    )
    await useMyWorkStore.getState().hydrate()
    expect(useMyWorkStore.getState().issues.map((i) => i.key)).toEqual(['A-1'])
  })

  test('an auth failure with no board shows the auth error state and NEVER opens the login', async () => {
    mocked.list.mockResolvedValue(
      board({ fetchedAt: null, error: { kind: 'auth', message: 'Jira SSO session expired' } })
    )
    await useMyWorkStore.getState().hydrate()
    const s = useMyWorkStore.getState()
    expect(s.status).toBe('error')
    expect(s.errorKind).toBe('auth')
    expect(mocked.login).not.toHaveBeenCalled()
    expect(mocked.refresh).not.toHaveBeenCalled()
  })

  test('every distinct error kind lands with its kind intact', async () => {
    for (const kind of ['not-configured', 'auth', 'network', 'server', 'other'] as const) {
      reset()
      mocked.list.mockResolvedValue(board({ fetchedAt: null, error: { kind, message: 'x' } }))
      await useMyWorkStore.getState().hydrate()
      expect(useMyWorkStore.getState().status).toBe('error')
      expect(useMyWorkStore.getState().errorKind).toBe(kind)
    }
  })

  test('an error alongside a last-good board keeps the board visible and stays ready', async () => {
    mocked.list.mockResolvedValue(
      board({
        issues: [issue('A-1')],
        fetchedAt: 42,
        error: { kind: 'network', message: 'fetch failed [ENOTFOUND]' }
      })
    )
    await useMyWorkStore.getState().hydrate()
    const s = useMyWorkStore.getState()
    expect(s.status).toBe('ready')
    expect(s.issues.map((i) => i.key)).toEqual(['A-1'])
    expect(s.errorKind).toBe('network')
    expect(s.error).toMatch(/ENOTFOUND/)
    expect(mocked.login).not.toHaveBeenCalled()
  })

  test('a partial result surfaces the partial flag', async () => {
    mocked.list.mockResolvedValue(board({ issues: [issue('A-1')], partial: true }))
    await useMyWorkStore.getState().hydrate()
    expect(useMyWorkStore.getState().partial).toBe(true)
  })

  test('hydrate maps a rejected IPC call to a generic error', async () => {
    mocked.list.mockRejectedValue(new Error('bridge gone'))
    await useMyWorkStore.getState().hydrate()
    const s = useMyWorkStore.getState()
    expect(s.status).toBe('error')
    expect(s.errorKind).toBe('other')
    expect(s.error).toMatch(/bridge gone/)
  })

  test('refresh replaces the board and clears a previous error', async () => {
    reset({ status: 'error', error: 'old', errorKind: 'auth' })
    mocked.refresh.mockResolvedValue(board({ issues: [issue('A-2')], fetchedAt: 99 }))
    await useMyWorkStore.getState().refresh()
    const s = useMyWorkStore.getState()
    expect(s.status).toBe('ready')
    expect(s.issues.map((i) => i.key)).toEqual(['A-2'])
    expect(s.fetchedAt).toBe(99)
    expect(s.error).toBeNull()
    expect(s.errorKind).toBeNull()
  })

  test('a failed refresh keeps the last-good board and stays ready', async () => {
    reset({ status: 'ready', issues: [issue('A-1')], fetchedAt: 42 })
    mocked.refresh.mockResolvedValue(
      board({ issues: [issue('A-1')], fetchedAt: 42, error: { kind: 'server', message: 'HTTP 500' } })
    )
    await useMyWorkStore.getState().refresh()
    const s = useMyWorkStore.getState()
    expect(s.status).toBe('ready')
    expect(s.issues.map((i) => i.key)).toEqual(['A-1'])
    expect(s.errorKind).toBe('server')
  })

  test('a refresh auth failure keeps the stale board and never opens the login by itself', async () => {
    reset({ status: 'ready', issues: [issue('A-1')], fetchedAt: 42 })
    mocked.refresh.mockResolvedValue(
      board({ issues: [issue('A-1')], fetchedAt: 42, error: { kind: 'auth', message: 'expired' } })
    )
    await useMyWorkStore.getState().refresh()
    const s = useMyWorkStore.getState()
    expect(s.status).toBe('ready')
    expect(s.errorKind).toBe('auth')
    expect(mocked.login).not.toHaveBeenCalled()
  })

  test('a rejected refresh keeps the stale board and stays ready', async () => {
    reset({ status: 'ready', issues: [issue('A-1')], fetchedAt: 42 })
    mocked.refresh.mockRejectedValue(new Error('bridge gone'))
    await useMyWorkStore.getState().refresh()
    expect(useMyWorkStore.getState().status).toBe('ready')
    expect(useMyWorkStore.getState().issues.map((i) => i.key)).toEqual(['A-1'])
  })
})

describe('push-driven refetch', () => {
  test('a global change push refetches the board quietly', async () => {
    let handler: ((event: MyWorkChangedEvent) => void) | null = null
    mocked.onChanged.mockImplementation((cb) => {
      handler = cb
      return () => {}
    })
    mocked.list.mockResolvedValue(board({ issues: [issue('NEW-1')], fetchedAt: 77 }))

    const unsubscribe = useMyWorkStore.getState().subscribe()
    handler!({ sourceKey: 'global' })
    await vi.waitFor(() =>
      expect(useMyWorkStore.getState().issues.map((i) => i.key)).toEqual(['NEW-1'])
    )
    expect(useMyWorkStore.getState().status).toBe('ready')
    unsubscribe()
  })

  test('a project-source change push is ignored by the global store', async () => {
    let handler: ((event: MyWorkChangedEvent) => void) | null = null
    mocked.onChanged.mockImplementation((cb) => {
      handler = cb
      return () => {}
    })
    useMyWorkStore.getState().subscribe()
    handler!({ sourceKey: 'project:p1' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocked.list).not.toHaveBeenCalled()
  })
})

describe('shared refresh fan-out to the PR inbox', () => {
  test('hydrate kicks off the PR sync once per app session, quietly', async () => {
    mocked.list.mockResolvedValue(board())
    await useMyWorkStore.getState().hydrate()
    expect(prInboxSync).toHaveBeenCalledOnce()
    expect(prInboxSync).toHaveBeenCalledWith({ quiet: true })
    // A second hydrate in the same session must not re-sync.
    await useMyWorkStore.getState().hydrate()
    expect(prInboxSync).toHaveBeenCalledOnce()
  })

  test('refresh always triggers both the Jira refresh and the PR sync', async () => {
    mocked.refresh.mockResolvedValue(board())
    await useMyWorkStore.getState().refresh()
    await useMyWorkStore.getState().refresh()
    expect(mocked.refresh).toHaveBeenCalledTimes(2)
    expect(prInboxSync).toHaveBeenCalledTimes(2)
  })

  test('a failed Jira refresh does not prevent the PR sync (they run in parallel)', async () => {
    mocked.refresh.mockResolvedValue(board({ fetchedAt: null, error: { kind: 'other', message: 'boom' } }))
    await useMyWorkStore.getState().refresh()
    expect(prInboxSync).toHaveBeenCalledOnce()
  })
})

describe('openPr', () => {
  test('records the open intent for the app-layer wiring and clearPrOpen resets it', () => {
    useMyWorkStore.getState().openPr('repo-a', 42)
    expect(useMyWorkStore.getState().pendingPrOpen).toEqual({ repositoryId: 'repo-a', prId: 42 })
    useMyWorkStore.getState().clearPrOpen()
    expect(useMyWorkStore.getState().pendingPrOpen).toBeNull()
  })
})

describe('loginAndRefresh', () => {
  test('a completed login is followed by one forced fresh fetch', async () => {
    mocked.login.mockResolvedValue({ ok: true })
    mocked.refresh.mockResolvedValue(board({ issues: [issue('A-1')], fetchedAt: 7 }))
    await useMyWorkStore.getState().loginAndRefresh()
    const s = useMyWorkStore.getState()
    expect(s.status).toBe('ready')
    expect(s.issues.map((i) => i.key)).toEqual(['A-1'])
  })

  test('an abandoned login lands on the auth error state', async () => {
    mocked.login.mockResolvedValue({ ok: false, message: 'closed' })
    await useMyWorkStore.getState().loginAndRefresh()
    const s = useMyWorkStore.getState()
    expect(s.status).toBe('error')
    expect(s.errorKind).toBe('auth')
    expect(mocked.refresh).not.toHaveBeenCalled()
  })

  test('an abandoned login over a stale board keeps the board visible', async () => {
    reset({ status: 'ready', issues: [issue('A-1')], fetchedAt: 42 })
    mocked.login.mockResolvedValue({ ok: false, message: 'closed' })
    await useMyWorkStore.getState().loginAndRefresh()
    const s = useMyWorkStore.getState()
    expect(s.status).toBe('ready')
    expect(s.issues.map((i) => i.key)).toEqual(['A-1'])
  })

  test('the store passes through the login status while the browser window is open', async () => {
    let statusDuringLogin: string | null = null
    mocked.login.mockImplementation(async () => {
      statusDuringLogin = useMyWorkStore.getState().status
      return { ok: false, message: 'closed' }
    })
    await useMyWorkStore.getState().loginAndRefresh()
    expect(statusDuringLogin).toBe('login')
  })
})

describe('openIssue', () => {
  test('hands the issue URL to the system browser bridge', async () => {
    mocked.openExternal.mockResolvedValue(undefined)
    const target = issue('FID2507-611')
    useMyWorkStore.getState().openIssue(target)
    expect(mocked.openExternal).toHaveBeenCalledWith(
      'https://jira.skoda.vwgroup.com/browse/FID2507-611'
    )
  })

  test('a failed open is swallowed into a toast, never an unhandled rejection', async () => {
    mocked.openExternal.mockRejectedValue(new Error('blocked'))
    useMyWorkStore.getState().openIssue(issue('A-1'))
    // Flush the rejection through the catch handler.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
