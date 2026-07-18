import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hookCwdMatches, projectSessionDir, sessionFileExists } from './sessionResume'

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
