import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, test } from 'vitest'
import { createTabRepo, type TabRepo } from './tabRepo'
import { createWorkspaceRepo, type WorkspaceRepo } from './workspaceRepo'
import { makeTestDb, makeTestDeps } from './testkit'

describe('tabRepo', () => {
  let db: DatabaseSync
  let tabs: TabRepo
  let workspaces: WorkspaceRepo
  let wsId: string

  beforeEach(() => {
    db = makeTestDb()
    const deps = makeTestDeps()
    workspaces = createWorkspaceRepo(db, deps)
    tabs = createTabRepo(db, deps)
    wsId = workspaces.create('/a').id
  })

  /** The workspace's tabs as `id@slot:order`, read back from the database. */
  const placements = (): string[] =>
    tabs.listByWorkspace(wsId).map((t) => `${t.id}@${t.paneSlot}:${t.sortOrder}`)

  test('create defaults the title from the preset and lands in group 0', () => {
    const shell = tabs.create(wsId, 'shell')
    expect(shell.title).toBe('Shell')
    expect(shell.preset).toBe('shell')
    expect(shell.paneSlot).toBe(0)
    expect(shell.lastActiveAt).toBeNull()
    expect(shell.workspaceId).toBe(wsId)
    expect(tabs.create(wsId, 'claude').title).toBe('Claude')
  })

  test('create appends at the end of the group it is given, numbering each group from 0', () => {
    const a = tabs.create(wsId, 'shell', undefined, null, 1)
    const b = tabs.create(wsId, 'shell', undefined, null, 1)
    const c = tabs.create(wsId, 'shell', undefined, null, 0)
    expect([a.paneSlot, a.sortOrder]).toEqual([1, 0])
    expect([b.paneSlot, b.sortOrder]).toEqual([1, 1])
    expect([c.paneSlot, c.sortOrder]).toEqual([0, 0])
  })

  test('create defaults to no resume session, and round-trips one when given', () => {
    expect(tabs.create(wsId, 'claude').resumeSessionId).toBeNull()
    const resumed = tabs.create(wsId, 'claude', undefined, 'sess-uuid-42')
    expect(resumed.resumeSessionId).toBe('sess-uuid-42')
    expect(tabs.getById(resumed.id)?.resumeSessionId).toBe('sess-uuid-42')
  })

  test('setResumeSessionId persists the live session UUID and clears with null', () => {
    const tab = tabs.create(wsId, 'claude')
    tabs.setResumeSessionId(tab.id, 'captured-uuid')
    expect(tabs.getById(tab.id)?.resumeSessionId).toBe('captured-uuid')
    tabs.setResumeSessionId(tab.id, null)
    expect(tabs.getById(tab.id)?.resumeSessionId).toBeNull()
  })

  test('setResumeSessionId on an unknown tab is a silent no-op', () => {
    expect(() => tabs.setResumeSessionId('nope', 'x')).not.toThrow()
  })

  test('listByWorkspace returns tabs ordered by group, then by position inside the group', () => {
    const a = tabs.create(wsId, 'shell', undefined, null, 1)
    const b = tabs.create(wsId, 'claude', undefined, null, 0)
    const c = tabs.create(wsId, 'shell', undefined, null, 1)
    const d = tabs.create(wsId, 'shell', undefined, null, 0)
    expect(tabs.listByWorkspace(wsId).map((t) => t.id)).toEqual([b.id, d.id, a.id, c.id])
  })

  test('a tab whose slot was never written reads as group 0', () => {
    const t = tabs.create(wsId, 'shell')
    db.prepare('UPDATE tabs SET pane_slot = NULL WHERE id = ?').run(t.id)
    expect(tabs.getById(t.id)?.paneSlot).toBe(0)
    expect(tabs.listByWorkspace(wsId)[0].paneSlot).toBe(0)
  })

  test('listByWorkspace is scoped to one workspace', () => {
    const other = workspaces.create('/b').id
    tabs.create(wsId, 'shell')
    tabs.create(other, 'shell')
    expect(tabs.listByWorkspace(wsId)).toHaveLength(1)
    expect(tabs.listByWorkspace(other)).toHaveLength(1)
  })

  test('rename updates the title', () => {
    const t = tabs.create(wsId, 'shell')
    expect(tabs.rename(t.id, 'build').title).toBe('build')
    expect(tabs.getById(t.id)?.title).toBe('build')
  })

  test('remove deletes the tab and closes the gap in its group', () => {
    const a = tabs.create(wsId, 'shell')
    const b = tabs.create(wsId, 'shell')
    const c = tabs.create(wsId, 'shell')
    const other = tabs.create(wsId, 'shell', undefined, null, 1)
    tabs.remove(b.id)
    expect(tabs.getById(b.id)).toBeUndefined()
    expect(placements()).toEqual([`${a.id}@0:0`, `${c.id}@0:1`, `${other.id}@1:0`])
  })

  test('remove of an unknown tab is a silent no-op', () => {
    const a = tabs.create(wsId, 'shell')
    expect(() => tabs.remove('nope')).not.toThrow()
    expect(tabs.listByWorkspace(wsId).map((t) => t.id)).toEqual([a.id])
  })

  test('rename throws for a missing tab', () => {
    expect(() => tabs.rename('missing', 'x')).toThrow(/not found/i)
  })

  describe('moveToGroup', () => {
    test('moves a tab into another group at the given index and renumbers both', () => {
      const a = tabs.create(wsId, 'shell')
      const b = tabs.create(wsId, 'shell')
      const c = tabs.create(wsId, 'shell')
      const x = tabs.create(wsId, 'shell', undefined, null, 1)
      const y = tabs.create(wsId, 'shell', undefined, null, 1)

      const after = tabs.moveToGroup(b.id, 1, 1)
      expect(after.map((t) => `${t.id}@${t.paneSlot}:${t.sortOrder}`)).toEqual([
        `${a.id}@0:0`,
        `${c.id}@0:1`,
        `${x.id}@1:0`,
        `${b.id}@1:1`,
        `${y.id}@1:2`
      ])
      expect(placements()).toEqual(after.map((t) => `${t.id}@${t.paneSlot}:${t.sortOrder}`))
    })

    test('a move inside the same group is a plain reorder', () => {
      const a = tabs.create(wsId, 'shell')
      const b = tabs.create(wsId, 'shell')
      const c = tabs.create(wsId, 'shell')
      tabs.moveToGroup(c.id, 0, 0)
      expect(placements()).toEqual([`${c.id}@0:0`, `${a.id}@0:1`, `${b.id}@0:2`])
      tabs.moveToGroup(c.id, 0, 2)
      expect(placements()).toEqual([`${a.id}@0:0`, `${b.id}@0:1`, `${c.id}@0:2`])
    })

    test('an index past the end appends, and a negative index goes first', () => {
      const a = tabs.create(wsId, 'shell')
      const b = tabs.create(wsId, 'shell')
      tabs.moveToGroup(a.id, 0, 99)
      expect(placements()).toEqual([`${b.id}@0:0`, `${a.id}@0:1`])
      tabs.moveToGroup(a.id, 0, -5)
      expect(placements()).toEqual([`${a.id}@0:0`, `${b.id}@0:1`])
    })

    test('moving into an empty group leaves the source dense', () => {
      const a = tabs.create(wsId, 'shell')
      const b = tabs.create(wsId, 'shell')
      const c = tabs.create(wsId, 'shell')
      tabs.moveToGroup(a.id, 3, 0)
      expect(placements()).toEqual([`${b.id}@0:0`, `${c.id}@0:1`, `${a.id}@3:0`])
    })

    test('leaves other workspaces alone', () => {
      const other = workspaces.create('/b').id
      const mine = tabs.create(wsId, 'shell')
      const theirs = tabs.create(other, 'shell')
      tabs.moveToGroup(mine.id, 1, 0)
      expect(tabs.getById(theirs.id)?.paneSlot).toBe(0)
      expect(tabs.listByWorkspace(other)).toHaveLength(1)
    })

    test('throws for a missing tab and writes nothing', () => {
      const a = tabs.create(wsId, 'shell')
      expect(() => tabs.moveToGroup('missing', 1, 0)).toThrow(/not found/i)
      expect(placements()).toEqual([`${a.id}@0:0`])
    })
  })

  describe('regroup', () => {
    test('merging two columns into single appends the right column after the left', () => {
      const a = tabs.create(wsId, 'shell')
      const b = tabs.create(wsId, 'shell')
      const x = tabs.create(wsId, 'shell', undefined, null, 1)
      const out = tabs.regroup(wsId, 'columns', 'single')
      expect(out.map((t) => `${t.id}@${t.paneSlot}:${t.sortOrder}`)).toEqual([
        `${a.id}@0:0`,
        `${b.id}@0:1`,
        `${x.id}@0:2`
      ])
      expect(placements()).toEqual([`${a.id}@0:0`, `${b.id}@0:1`, `${x.id}@0:2`])
    })

    test('growing rows into the grid moves the bottom row to the bottom-left pane', () => {
      const top = tabs.create(wsId, 'shell')
      const bottom = tabs.create(wsId, 'shell', undefined, null, 1)
      tabs.regroup(wsId, 'rows', 'grid')
      expect(placements()).toEqual([`${top.id}@0:0`, `${bottom.id}@2:0`])
    })

    test('is scoped to one workspace', () => {
      const other = workspaces.create('/b').id
      tabs.create(wsId, 'shell', undefined, null, 1)
      const theirs = tabs.create(other, 'shell', undefined, null, 1)
      tabs.regroup(wsId, 'columns', 'single')
      expect(tabs.getById(theirs.id)?.paneSlot).toBe(1)
    })
  })

  describe('touchActive', () => {
    test('stamps the activation time and leaves the other tabs untouched', () => {
      const a = tabs.create(wsId, 'shell')
      const b = tabs.create(wsId, 'shell')
      expect(tabs.touchActive(a.id, 1700).lastActiveAt).toBe(1700)
      expect(tabs.getById(a.id)?.lastActiveAt).toBe(1700)
      expect(tabs.getById(b.id)?.lastActiveAt).toBeNull()
    })

    test('a later activation replaces the earlier stamp', () => {
      const a = tabs.create(wsId, 'shell')
      tabs.touchActive(a.id, 1700)
      expect(tabs.touchActive(a.id, 2400).lastActiveAt).toBe(2400)
    })

    test('throws for a missing tab', () => {
      expect(() => tabs.touchActive('missing', 1)).toThrow(/not found/i)
    })
  })

  describe('suspend/resume lifecycle', () => {
    test('a fresh tab has no suspend marker', () => {
      const t = tabs.create(wsId, 'claude')
      expect(t.sessionStatus).toBeNull()
      expect(t.suspendReason).toBeNull()
      expect(t.suspendedAt).toBeNull()
    })

    test('setSuspended marks the tab suspended, records the reason and time, and audits it', () => {
      const t = tabs.create(wsId, 'claude')
      tabs.setSuspended(t.id, 'app-quit-suspend')
      const stored = tabs.getById(t.id)
      expect(stored?.sessionStatus).toBe('suspended')
      expect(stored?.suspendReason).toBe('app-quit-suspend')
      expect(typeof stored?.suspendedAt).toBe('number')
      const history = tabs.history(t.id)
      expect(history.map((e) => e.action)).toEqual(['suspend'])
      expect(history[0].reason).toBe('app-quit-suspend')
      expect(history[0].tabId).toBe(t.id)
    })

    test('a distinct reason is preserved for a session that never captured a resume id', () => {
      const t = tabs.create(wsId, 'claude')
      tabs.setSuspended(t.id, 'no-session-id')
      expect(tabs.getById(t.id)?.suspendReason).toBe('no-session-id')
    })

    test('setResumeFailed moves a tab to the recoverable state and audits it', () => {
      const t = tabs.create(wsId, 'claude')
      tabs.setSuspended(t.id, 'app-quit-suspend')
      tabs.setResumeFailed(t.id, 'resume-failed')
      expect(tabs.getById(t.id)?.sessionStatus).toBe('resume-failed')
      expect(tabs.history(t.id).map((e) => e.action)).toEqual(['suspend', 'resume-failed'])
    })

    test('clearSuspended wipes the marker and audits a resume', () => {
      const t = tabs.create(wsId, 'claude')
      tabs.setSuspended(t.id, 'app-quit-suspend')
      tabs.clearSuspended(t.id)
      const stored = tabs.getById(t.id)
      expect(stored?.sessionStatus).toBeNull()
      expect(stored?.suspendReason).toBeNull()
      expect(stored?.suspendedAt).toBeNull()
      expect(tabs.history(t.id).map((e) => e.action)).toEqual(['suspend', 'resume'])
    })

    test('listSuspended returns only currently-suspended tabs, ordered by suspend time', () => {
      const a = tabs.create(wsId, 'claude')
      const b = tabs.create(wsId, 'claude')
      const c = tabs.create(wsId, 'claude')
      tabs.setSuspended(a.id, 'app-quit-suspend')
      tabs.setSuspended(b.id, 'app-quit-suspend')
      tabs.setResumeFailed(b.id, 'resume-failed') // no longer 'suspended'
      tabs.setSuspended(c.id, 'app-quit-suspend')
      expect(tabs.listSuspended().map((t) => t.id)).toEqual([a.id, c.id])
    })

    test('the suspend audit survives the tab being deleted', () => {
      const t = tabs.create(wsId, 'claude')
      tabs.setSuspended(t.id, 'app-quit-suspend')
      tabs.remove(t.id)
      expect(tabs.getById(t.id)).toBeUndefined()
      expect(tabs.history(t.id).map((e) => e.action)).toEqual(['suspend'])
    })

    test('setSuspended on an unknown tab is a silent no-op and audits nothing', () => {
      expect(() => tabs.setSuspended('nope', 'app-quit-suspend')).not.toThrow()
      expect(tabs.history('nope')).toEqual([])
    })
  })
})
