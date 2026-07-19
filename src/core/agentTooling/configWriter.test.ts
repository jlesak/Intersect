import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createConfigWriter } from './configWriter'
import { createMemoryConfigFs } from './memoryConfigFs'
import type { ResolvedScope } from './configPaths'

/**
 * Pipeline-logic coverage over the in-memory double: the revision guard, backup accounting,
 * temp-file cleanup, and undo byte-equality, all without touching disk. Filesystem-specific
 * guarantees (mode preservation, symlink containment) live in the realfs suite.
 */
describe('createConfigWriter (in-memory)', () => {
  const home = '/home/.claude'
  const globalScope: ResolvedScope = { kind: 'global' }
  const globalSettings = join(home, 'settings.json')

  const build = (seed: Record<string, string> = {}) => {
    const mem = createMemoryConfigFs(seed)
    const writer = createConfigWriter({
      fs: mem.read,
      writeFs: mem.write,
      claudeHome: home,
      clock: () => new Date(2026, 6, 18, 1, 2, 3, 9)
    })
    return { mem, writer }
  }

  test('preview leaves the store untouched', () => {
    const { mem, writer } = build({ [globalSettings]: '{"a":1}' })
    writer.preview(globalScope, 'global', { kind: 'advanced', op: 'set', key: 'a', value: '2' })
    expect(mem.files.get(globalSettings)?.data).toBe('{"a":1}')
  })

  test('a stale revision is rejected before any write', () => {
    const { mem, writer } = build({ [globalSettings]: '{"a":1}' })
    const result = writer.save(
      globalScope,
      'global',
      { kind: 'advanced', op: 'set', key: 'a', value: '2' },
      'stale-revision'
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('changed-externally')
    expect(mem.files.get(globalSettings)?.data).toBe('{"a":1}')
  })

  test('a valid save writes, backs up, and records an undo handle', () => {
    const { mem, writer } = build({ [globalSettings]: '{"a":1}' })
    const edit = { kind: 'advanced', op: 'set', key: 'a', value: '2' } as const
    const preview = writer.preview(globalScope, 'global', edit)
    const result = writer.save(globalScope, 'global', edit, preview.revision)

    expect(result.ok).toBe(true)
    expect(result.backupPath).toBe(`${globalSettings}.bak.20260718-010203-009`)
    expect(mem.files.get(result.backupPath!)?.data).toBe('{"a":1}')
    expect(JSON.parse(mem.files.get(globalSettings)!.data).a).toBe(2)
    // No temp artifact remains.
    expect(mem.has(`${globalSettings}.intersect-tmp`)).toBe(false)
  })

  test('undo restores exact prior bytes and is one-shot', () => {
    const { mem, writer } = build({ [globalSettings]: '{"a":1}' })
    const edit = { kind: 'advanced', op: 'set', key: 'a', value: '2' } as const
    const preview = writer.preview(globalScope, 'global', edit)
    writer.save(globalScope, 'global', edit, preview.revision)

    const undo = writer.undo(globalSettings)
    expect(undo.ok).toBe(true)
    expect(mem.files.get(globalSettings)?.data).toBe('{"a":1}')

    // A second undo has no handle left to consume.
    const again = writer.undo(globalSettings)
    expect(again.ok).toBe(false)
    expect(again.reason).toBe('no-handle')
  })

  test('an invalid edit is rejected and never writes', () => {
    const { mem, writer } = build({ [globalSettings]: '{"a":1}' })
    const edit = { kind: 'advanced', op: 'set', key: 'x', value: 'not json' } as const
    const preview = writer.preview(globalScope, 'global', edit)
    expect(preview.valid).toBe(false)

    const result = writer.save(globalScope, 'global', edit, preview.revision)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('invalid')
    expect(mem.files.get(globalSettings)?.data).toBe('{"a":1}')
  })

  test('readTarget reflects an absent file with the absent sentinel revision', () => {
    const { writer } = build()
    const view = writer.readTarget(globalScope, 'global')
    expect(view.exists).toBe(false)
    expect(view.content).toBe('')
    expect(view.revision).toBe('absent')
    expect(view.global).toBe(true)
  })
})
