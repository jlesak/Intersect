import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  hookCwdMatches,
  projectSessionDir,
  reconcileSuspendedTabs,
  resolveResumeTarget,
  sessionFileExists,
  type SuspendedTab
} from './sessionResume'

describe('hookCwdMatches', () => {
  const CWD = '/Users/jan/Projects/Intersect'

  it('accepts the managed session (same cwd)', () => {
    expect(hookCwdMatches(CWD, CWD)).toBe(true)
  })

  it('rejects a nested claude running from /private/tmp (the contamination bug)', () => {
    expect(hookCwdMatches(CWD, '/private/tmp')).toBe(false)
  })

  it('rejects a nested claude running from a temp folder', () => {
    expect(hookCwdMatches(CWD, '/private/var/folders/tp/x41274sn7lg/T')).toBe(false)
  })

  it('ignores a trailing slash difference', () => {
    expect(hookCwdMatches('/a/b/c', '/a/b/c/')).toBe(true)
  })

  it('resolves symlinks so /tmp and /private/tmp compare equal (macOS)', () => {
    // Only meaningful where /tmp is a symlink; on such systems both sides canonicalize
    // to the same real path.
    expect(hookCwdMatches('/tmp', '/tmp')).toBe(true)
  })

  it('allows events with no cwd to discriminate on (back-compat)', () => {
    expect(hookCwdMatches(CWD, undefined)).toBe(true)
    expect(hookCwdMatches(CWD, '')).toBe(true)
  })

  it('treats a non-string cwd payload field like a missing one (cannot discriminate)', () => {
    expect(hookCwdMatches(CWD, 42 as unknown)).toBe(true)
  })

  it('rejects when the instance cwd is unknown', () => {
    expect(hookCwdMatches(undefined, CWD)).toBe(false)
  })
})

describe('projectSessionDir', () => {
  it('slugifies the cwd the way Claude Code does', () => {
    expect(projectSessionDir('/Users/jan/Projects/Intersect')).toMatch(
      /\/\.claude\/projects\/-Users-jan-Projects-Intersect$/
    )
    expect(projectSessionDir('/private/tmp')).toMatch(/\/-private-tmp$/)
  })
})

describe('sessionFileExists', () => {
  let cleanup: string | null = null

  afterEach(() => {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true })
    cleanup = null
  })

  it('is false for an empty session id', () => {
    expect(sessionFileExists('/anywhere', '')).toBe(false)
  })

  it('is false when no transcript exists under the project dir', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'intersect-resume-'))
    cleanup = cwd
    expect(sessionFileExists(cwd, 'no-such-session')).toBe(false)
  })

  it('is true when the transcript file exists under the project dir', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'intersect-resume-'))
    cleanup = cwd
    const dir = projectSessionDir(cwd)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session-1.jsonl'), '')
    try {
      expect(sessionFileExists(cwd, 'session-1')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveResumeTarget', () => {
  const CWD = '/Users/jan/Projects/Intersect'

  it('returns the stored id when its transcript exists under this cwd', () => {
    const exists = (cwd: string, id: string): boolean => cwd === CWD && id === 'stored-uuid'
    expect(resolveResumeTarget(CWD, 'stored-uuid', exists)).toBe('stored-uuid')
  })

  it('rejects a foreign/nested id with no transcript under this cwd (returns null)', () => {
    // The nested id has a transcript, but only under a DIFFERENT cwd, so from here it is unresolvable.
    const exists = (cwd: string, id: string): boolean => cwd === '/private/tmp' && id === 'nested-uuid'
    expect(resolveResumeTarget(CWD, 'nested-uuid', exists)).toBeNull()
  })

  it('returns null when the stored id has no transcript at all (fresh spawn)', () => {
    expect(resolveResumeTarget(CWD, 'missing-uuid', () => false)).toBeNull()
  })

  it('returns null when there is no stored id', () => {
    expect(resolveResumeTarget(CWD, null, () => true)).toBeNull()
  })
})

describe('reconcileSuspendedTabs', () => {
  const cwdOf = (id: string): string | undefined => (id === 'ws-ok' ? '/repo' : id === 'ws-missing' ? undefined : '/other')

  it('keeps a suspended tab whose transcript resolves and never spawns anything', () => {
    const setResumeFailed = vi.fn()
    const tabs: SuspendedTab[] = [{ id: 't-ok', workspaceId: 'ws-ok', resumeSessionId: 'good-uuid' }]
    reconcileSuspendedTabs(
      { listSuspended: () => tabs, workspaceCwd: cwdOf, setResumeFailed },
      (cwd, id) => cwd === '/repo' && id === 'good-uuid'
    )
    expect(setResumeFailed).not.toHaveBeenCalled()
  })

  it('degrades a tab with no resolvable transcript to resume-failed', () => {
    const setResumeFailed = vi.fn()
    const tabs: SuspendedTab[] = [{ id: 't-bad', workspaceId: 'ws-ok', resumeSessionId: 'gone-uuid' }]
    reconcileSuspendedTabs({ listSuspended: () => tabs, workspaceCwd: cwdOf, setResumeFailed }, () => false)
    expect(setResumeFailed).toHaveBeenCalledWith('t-bad', 'resume-failed')
  })

  it('degrades a tab whose workspace cwd is unknown, without calling the fs check', () => {
    const setResumeFailed = vi.fn()
    const exists = vi.fn(() => true)
    const tabs: SuspendedTab[] = [{ id: 't-nocwd', workspaceId: 'ws-missing', resumeSessionId: 'x' }]
    reconcileSuspendedTabs({ listSuspended: () => tabs, workspaceCwd: cwdOf, setResumeFailed }, exists)
    expect(setResumeFailed).toHaveBeenCalledWith('t-nocwd', 'resume-failed')
    expect(exists).not.toHaveBeenCalled()
  })

  it('degrades a tab that never captured a resume id (no-session-id case)', () => {
    const setResumeFailed = vi.fn()
    const tabs: SuspendedTab[] = [{ id: 't-none', workspaceId: 'ws-ok', resumeSessionId: null }]
    reconcileSuspendedTabs({ listSuspended: () => tabs, workspaceCwd: cwdOf, setResumeFailed }, () => true)
    expect(setResumeFailed).toHaveBeenCalledWith('t-none', 'resume-failed')
  })
})
