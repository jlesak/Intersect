import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { JiraIssue } from '@common/domain'

vi.mock('./ipc')
// The store fans a shared refresh out to the prInbox slice; stub its store so these tests stay
// isolated from that slice (and from the heavyweight components its barrel re-exports).
const prInboxSync = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@renderer/features/prInbox', () => ({
  usePrInboxStore: { getState: () => ({ sync: prInboxSync }) }
}))
import * as api from './ipc'
import { formatRelativeTime, groupByColumn, useMyWorkStore } from './store'

const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue => ({
  key,
  url: `https://jira.skoda.vwgroup.com/browse/${key}`,
  summary: `Issue ${key}`,
  column: 'todo',
  priority: null,
  updatedAt: 1000,
  ...over
})

const mocked = vi.mocked(api)

const reset = (over: Partial<ReturnType<typeof useMyWorkStore.getState>> = {}): void => {
  useMyWorkStore.setState(
    {
      status: 'idle',
      errorKind: null,
      error: null,
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
    const board = groupByColumn([
      issue('A-1', { column: 'progress' }),
      issue('A-2', { column: 'todo' }),
      issue('A-3', { column: 'progress' })
    ])
    expect(board.todo.map((i) => i.key)).toEqual(['A-2'])
    expect(board.progress.map((i) => i.key)).toEqual(['A-1', 'A-3'])
    expect(board.waiting).toEqual([])
    expect(board.review).toEqual([])
    expect(board.test).toEqual([])
  })

  test('sorts each column by last activity, newest first', () => {
    const board = groupByColumn([
      issue('A-1', { column: 'todo', updatedAt: 1 }),
      issue('A-3', { column: 'todo', updatedAt: 3 }),
      issue('A-2', { column: 'todo', updatedAt: 2 })
    ])
    expect(board.todo.map((i) => i.key)).toEqual(['A-3', 'A-2', 'A-1'])
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
  test('hydrate loads the board and is ready', async () => {
    mocked.list.mockResolvedValue({ ok: true, issues: [issue('A-1')], fetchedAt: 42 })
    await useMyWorkStore.getState().hydrate()
    const s = useMyWorkStore.getState()
    expect(s.status).toBe('ready')
    expect(s.issues.map((i) => i.key)).toEqual(['A-1'])
    expect(s.fetchedAt).toBe(42)
  })

  test('hydrate with a stale persisted board shows it and refreshes in the background', async () => {
    mocked.list.mockResolvedValue({
      ok: true,
      issues: [issue('OLD-1')],
      fetchedAt: Date.now() - 2 * 60 * 60_000
    })
    mocked.refresh.mockResolvedValue({ ok: true, issues: [issue('NEW-1')], fetchedAt: Date.now() })
    await useMyWorkStore.getState().hydrate()
    await vi.waitFor(() =>
      expect(useMyWorkStore.getState().issues.map((i) => i.key)).toEqual(['NEW-1'])
    )
    expect(useMyWorkStore.getState().status).toBe('ready')
  })

  test('hydrate with a fresh board does not refetch', async () => {
    mocked.list.mockResolvedValue({ ok: true, issues: [issue('A-1')], fetchedAt: Date.now() })
    await useMyWorkStore.getState().hydrate()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocked.refresh).not.toHaveBeenCalled()
  })

  test('hydrate on an auth failure runs the login and retries with a fresh fetch', async () => {
    mocked.list.mockResolvedValue({ ok: false, kind: 'auth', message: 'Jira SSO session expired' })
    mocked.login.mockResolvedValue({ ok: true })
    mocked.refresh.mockResolvedValue({ ok: true, issues: [issue('A-1')], fetchedAt: Date.now() })
    await useMyWorkStore.getState().hydrate()
    const s = useMyWorkStore.getState()
    expect(s.status).toBe('ready')
    expect(s.issues.map((i) => i.key)).toEqual(['A-1'])
    expect(mocked.login).toHaveBeenCalledOnce()
    expect(mocked.refresh).toHaveBeenCalledOnce()
  })

  test('hydrate lands on the auth error state when the login is not completed', async () => {
    mocked.list.mockResolvedValue({ ok: false, kind: 'auth', message: 'Jira SSO session expired' })
    mocked.login.mockResolvedValue({ ok: false, message: 'The Jira login was not completed.' })
    await useMyWorkStore.getState().hydrate()
    const s = useMyWorkStore.getState()
    expect(s.status).toBe('error')
    expect(s.errorKind).toBe('auth')
    expect(s.error).toMatch(/not completed/)
    expect(mocked.refresh).not.toHaveBeenCalled()
  })

  test('an auth failure after a completed login does not loop into another login', async () => {
    mocked.list.mockResolvedValue({ ok: false, kind: 'auth', message: 'expired' })
    mocked.login.mockResolvedValue({ ok: true })
    mocked.refresh.mockResolvedValue({ ok: false, kind: 'auth', message: 'still expired' })
    await useMyWorkStore.getState().hydrate()
    const s = useMyWorkStore.getState()
    expect(s.status).toBe('error')
    expect(s.errorKind).toBe('auth')
    expect(mocked.login).toHaveBeenCalledOnce()
  })

  test('the store passes through the login status while the browser window is open', async () => {
    mocked.list.mockResolvedValue({ ok: false, kind: 'auth', message: 'expired' })
    let statusDuringLogin: string | null = null
    mocked.login.mockImplementation(async () => {
      statusDuringLogin = useMyWorkStore.getState().status
      return { ok: false, message: 'closed' }
    })
    await useMyWorkStore.getState().hydrate()
    expect(statusDuringLogin).toBe('login')
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
    mocked.refresh.mockResolvedValue({ ok: true, issues: [issue('A-2')], fetchedAt: 99 })
    await useMyWorkStore.getState().refresh()
    const s = useMyWorkStore.getState()
    expect(s.status).toBe('ready')
    expect(s.issues.map((i) => i.key)).toEqual(['A-2'])
    expect(s.fetchedAt).toBe(99)
    expect(s.error).toBeNull()
    expect(s.errorKind).toBeNull()
  })

  test('a failed refresh keeps the stale board and stays ready', async () => {
    reset({ status: 'ready', issues: [issue('A-1')], fetchedAt: 42 })
    mocked.refresh.mockResolvedValue({ ok: false, kind: 'other', message: 'boom' })
    await useMyWorkStore.getState().refresh()
    const s = useMyWorkStore.getState()
    expect(s.status).toBe('ready')
    expect(s.issues.map((i) => i.key)).toEqual(['A-1'])
  })

  test('a failed refresh with nothing to fall back to shows the error state', async () => {
    mocked.refresh.mockResolvedValue({ ok: false, kind: 'other', message: 'boom' })
    await useMyWorkStore.getState().refresh()
    const s = useMyWorkStore.getState()
    expect(s.status).toBe('error')
    expect(s.errorKind).toBe('other')
  })

  test('a refresh auth failure over a stale board runs the login and then refetches', async () => {
    reset({ status: 'ready', issues: [issue('A-1')], fetchedAt: 42 })
    mocked.refresh
      .mockResolvedValueOnce({ ok: false, kind: 'auth', message: 'expired' })
      .mockResolvedValueOnce({ ok: true, issues: [issue('A-2')], fetchedAt: 99 })
    mocked.login.mockResolvedValue({ ok: true })
    await useMyWorkStore.getState().refresh()
    const s = useMyWorkStore.getState()
    expect(s.status).toBe('ready')
    expect(s.issues.map((i) => i.key)).toEqual(['A-2'])
    expect(mocked.login).toHaveBeenCalledOnce()
  })

  test('a refresh auth failure with an abandoned login keeps the stale board', async () => {
    reset({ status: 'ready', issues: [issue('A-1')], fetchedAt: 42 })
    mocked.refresh.mockResolvedValue({ ok: false, kind: 'auth', message: 'expired' })
    mocked.login.mockResolvedValue({ ok: false, message: 'closed' })
    await useMyWorkStore.getState().refresh()
    const s = useMyWorkStore.getState()
    expect(s.status).toBe('ready')
    expect(s.issues.map((i) => i.key)).toEqual(['A-1'])
  })

  test('a rejected refresh keeps the stale board and stays ready', async () => {
    reset({ status: 'ready', issues: [issue('A-1')], fetchedAt: 42 })
    mocked.refresh.mockRejectedValue(new Error('bridge gone'))
    await useMyWorkStore.getState().refresh()
    expect(useMyWorkStore.getState().status).toBe('ready')
    expect(useMyWorkStore.getState().issues.map((i) => i.key)).toEqual(['A-1'])
  })
})

describe('shared refresh fan-out to the PR inbox', () => {
  test('hydrate kicks off the PR sync once per app session, quietly', async () => {
    mocked.list.mockResolvedValue({ ok: true, issues: [], fetchedAt: Date.now() })
    await useMyWorkStore.getState().hydrate()
    expect(prInboxSync).toHaveBeenCalledOnce()
    expect(prInboxSync).toHaveBeenCalledWith({ quiet: true })
    // A second hydrate in the same session must not re-sync.
    await useMyWorkStore.getState().hydrate()
    expect(prInboxSync).toHaveBeenCalledOnce()
  })

  test('the stale-board background refresh is Jira-only, never a second PR sync', async () => {
    mocked.list.mockResolvedValue({
      ok: true,
      issues: [issue('OLD-1')],
      fetchedAt: Date.now() - 2 * 60 * 60_000
    })
    mocked.refresh.mockResolvedValue({ ok: true, issues: [issue('NEW-1')], fetchedAt: Date.now() })
    await useMyWorkStore.getState().hydrate()
    await vi.waitFor(() =>
      expect(useMyWorkStore.getState().issues.map((i) => i.key)).toEqual(['NEW-1'])
    )
    expect(prInboxSync).toHaveBeenCalledOnce()
  })

  test('refresh always triggers both the Jira refresh and the PR sync', async () => {
    mocked.refresh.mockResolvedValue({ ok: true, issues: [], fetchedAt: Date.now() })
    await useMyWorkStore.getState().refresh()
    await useMyWorkStore.getState().refresh()
    expect(mocked.refresh).toHaveBeenCalledTimes(2)
    expect(prInboxSync).toHaveBeenCalledTimes(2)
  })

  test('a failed Jira refresh does not prevent the PR sync (they run in parallel)', async () => {
    mocked.refresh.mockResolvedValue({ ok: false, kind: 'other', message: 'boom' })
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
  test('a completed login is followed by one fresh fetch', async () => {
    mocked.login.mockResolvedValue({ ok: true })
    mocked.refresh.mockResolvedValue({ ok: true, issues: [issue('A-1')], fetchedAt: 7 })
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
