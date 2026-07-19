import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { defaultConfigFs, defaultConfigWriteFs } from './configFs'
import { createConfigWriter } from './configWriter'
import type { ResolvedScope } from './configPaths'

/**
 * The writer's guarantees that only a real filesystem can prove: mode preservation across the
 * temp + rename, an escaping symlink blocked before any byte is touched, no leftover temp file,
 * exact-byte backups and undo, and the create-only-on-save contract. Everything runs against a
 * throwaway temp directory - never the real `~/.claude`.
 */
describe('createConfigWriter (real filesystem)', () => {
  let dir: string
  let home: string
  let repo: string

  const fixedClock = () => new Date(2026, 6, 18, 9, 8, 7, 123) // 2026-07-18 09:08:07.123 local

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'intersect-configwriter-'))
    home = join(dir, 'home', '.claude')
    repo = join(dir, 'repo')
    mkdirSync(home, { recursive: true })
    mkdirSync(repo, { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const writer = (clock = fixedClock) =>
    createConfigWriter({ fs: defaultConfigFs, writeFs: defaultConfigWriteFs, claudeHome: home, clock })
  const globalScope: ResolvedScope = { kind: 'global' }
  const projectScope = (): ResolvedScope => ({ kind: 'project', repoRoots: [repo] })
  const projectSettings = () => join(repo, '.claude', 'settings.json')
  const globalSettings = () => join(home, 'settings.json')

  test('preview of a missing project file creates nothing and marks it a create', () => {
    const w = writer()
    const preview = w.preview(projectScope(), 'project', {
      kind: 'permission',
      op: 'add',
      list: 'allow',
      rule: 'Read(*)'
    })
    expect(preview.exists).toBe(false)
    expect(preview.valid).toBe(true)
    expect(preview.proposedContent).toContain('Read(*)')
    // The read/preview must not have materialized the project's .claude directory or any file.
    expect(existsSync(join(repo, '.claude'))).toBe(false)
  })

  test('save creates a missing project file (0o600) only on confirm, with no backup', () => {
    const w = writer()
    const edit = { kind: 'permission', op: 'add', list: 'allow', rule: 'Read(*)' } as const
    const preview = w.preview(projectScope(), 'project', edit)
    expect(existsSync(projectSettings())).toBe(false)

    const result = w.save(projectScope(), 'project', edit, preview.revision)
    expect(result.ok).toBe(true)
    expect(result.backupPath).toBeUndefined()
    expect(existsSync(projectSettings())).toBe(true)
    expect(statSync(projectSettings()).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(projectSettings(), 'utf8')).permissions.allow).toEqual(['Read(*)'])
  })

  test('a valid save backs up the prior bytes under an injected-clock filename', () => {
    writeFileSync(globalSettings(), '{"model":"opus"}')
    const w = writer()
    const edit = { kind: 'advanced', op: 'set', key: 'model', value: '"sonnet"' } as const
    const preview = w.preview(globalScope, 'global', edit)
    const result = w.save(globalScope, 'global', edit, preview.revision)

    expect(result.ok).toBe(true)
    expect(result.backupPath).toBe(`${globalSettings()}.bak.20260718-090807-123`)
    expect(readFileSync(result.backupPath!, 'utf8')).toBe('{"model":"opus"}')
    // The new content is the pretty-printed proposed bytes.
    expect(readFileSync(globalSettings(), 'utf8')).toBe(preview.proposedContent)
    expect(JSON.parse(readFileSync(globalSettings(), 'utf8')).model).toBe('sonnet')
  })

  test('save preserves the existing file mode and leaves no temp file behind', () => {
    writeFileSync(globalSettings(), '{"a":1}')
    chmodSync(globalSettings(), 0o640)
    const w = writer()
    const edit = { kind: 'advanced', op: 'set', key: 'a', value: '2' } as const
    const preview = w.preview(globalScope, 'global', edit)
    const result = w.save(globalScope, 'global', edit, preview.revision)

    expect(result.ok).toBe(true)
    expect(statSync(globalSettings()).mode & 0o777).toBe(0o640)
    expect(existsSync(`${globalSettings()}.intersect-tmp`)).toBe(false)
  })

  test('an external change between preview and save is rejected, original intact', () => {
    writeFileSync(globalSettings(), '{"a":1}')
    const w = writer()
    const edit = { kind: 'advanced', op: 'set', key: 'a', value: '2' } as const
    const preview = w.preview(globalScope, 'global', edit)

    // Someone edits the file out-of-band after the preview.
    writeFileSync(globalSettings(), '{"a":999}')
    const result = w.save(globalScope, 'global', edit, preview.revision)

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('changed-externally')
    expect(readFileSync(globalSettings(), 'utf8')).toBe('{"a":999}')
  })

  test('undo restores the exact prior bytes', () => {
    const prior = '{"a":1}\n'
    writeFileSync(globalSettings(), prior)
    const w = writer()
    const edit = { kind: 'advanced', op: 'set', key: 'a', value: '2' } as const
    const preview = w.preview(globalScope, 'global', edit)
    const saved = w.save(globalScope, 'global', edit, preview.revision)
    expect(saved.ok).toBe(true)
    expect(readFileSync(globalSettings(), 'utf8')).not.toBe(prior)

    const undo = w.undo(globalSettings())
    expect(undo.ok).toBe(true)
    expect(readFileSync(globalSettings(), 'utf8')).toBe(prior)
  })

  test('undo of a created file removes it again', () => {
    const w = writer()
    const edit = { kind: 'permission', op: 'add', list: 'allow', rule: 'Read(*)' } as const
    const preview = w.preview(projectScope(), 'project', edit)
    const saved = w.save(projectScope(), 'project', edit, preview.revision)
    expect(saved.ok).toBe(true)
    expect(existsSync(projectSettings())).toBe(true)

    const undo = w.undo(projectSettings())
    expect(undo.ok).toBe(true)
    expect(existsSync(projectSettings())).toBe(false)
  })

  test('undo is rejected when the file changed since the save', () => {
    writeFileSync(globalSettings(), '{"a":1}')
    const w = writer()
    const edit = { kind: 'advanced', op: 'set', key: 'a', value: '2' } as const
    const preview = w.preview(globalScope, 'global', edit)
    w.save(globalScope, 'global', edit, preview.revision)

    // The saved file is changed out-of-band; undo must refuse to clobber it.
    writeFileSync(globalSettings(), '{"a":777}')
    const undo = w.undo(globalSettings())
    expect(undo.ok).toBe(false)
    expect(undo.reason).toBe('changed-since-save')
    expect(readFileSync(globalSettings(), 'utf8')).toBe('{"a":777}')
  })

  test('a project file symlinked outside the repo root is blocked on save', () => {
    const outside = join(dir, 'outside')
    mkdirSync(outside, { recursive: true })
    const secret = join(outside, 'secret.json')
    writeFileSync(secret, '{"model":"ESCAPED"}')
    mkdirSync(join(repo, '.claude'), { recursive: true })
    symlinkSync(secret, projectSettings())

    const w = writer()
    const edit = { kind: 'advanced', op: 'set', key: 'model', value: '"pwned"' } as const
    // Revision does not matter: containment fails first.
    const result = w.save(projectScope(), 'project', edit, 'anything')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('blocked')
    expect(readFileSync(secret, 'utf8')).toBe('{"model":"ESCAPED"}')
  })

  test('an invalid raw shape is rejected and cleans up its temp file', () => {
    writeFileSync(globalSettings(), '{"a":1}')
    const w = writer()
    const edit = { kind: 'raw', content: '[1,2,3]\n' } as const
    const preview = w.preview(globalScope, 'global', edit)
    expect(preview.valid).toBe(false)

    const result = w.save(globalScope, 'global', edit, preview.revision)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('invalid')
    // Original intact, no temp artifact.
    expect(readFileSync(globalSettings(), 'utf8')).toBe('{"a":1}')
    expect(existsSync(`${globalSettings()}.intersect-tmp`)).toBe(false)
  })
})
