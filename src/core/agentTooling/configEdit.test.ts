import { describe, expect, test } from 'vitest'
import { applyEdit, ConfigEditError, parseTopLevelObject } from './configEdit'

/** Parse the produced text back so assertions read against structure, not formatting. */
const parse = (s: string): Record<string, unknown> => JSON.parse(s)

describe('parseTopLevelObject', () => {
  test('treats an empty file as an empty object', () => {
    expect(parseTopLevelObject('')).toEqual({})
    expect(parseTopLevelObject('   \n')).toEqual({})
  })

  test('rejects a non-object top-level (array, scalar, null)', () => {
    expect(() => parseTopLevelObject('[]')).toThrow(ConfigEditError)
    expect(() => parseTopLevelObject('42')).toThrow(ConfigEditError)
    expect(() => parseTopLevelObject('null')).toThrow(ConfigEditError)
  })

  test('rejects malformed JSON', () => {
    expect(() => parseTopLevelObject('{ not json')).toThrow(/Invalid JSON/)
  })
})

describe('raw edit', () => {
  test('returns the user text unchanged', () => {
    expect(applyEdit('{"a":1}', { kind: 'raw', content: '{"b":2}\n' })).toBe('{"b":2}\n')
  })
})

describe('permission edit', () => {
  const seed = JSON.stringify(
    {
      model: 'opus',
      permissions: { allow: ['Read(*)'], deny: ['Bash(rm)'] },
      customKey: { keep: true }
    },
    null,
    2
  )

  test('adds a rule while preserving unknown keys and sibling lists', () => {
    const out = parse(applyEdit(seed, { kind: 'permission', op: 'add', list: 'allow', rule: 'Write(*)' }))
    expect(out.permissions).toEqual({ allow: ['Read(*)', 'Write(*)'], deny: ['Bash(rm)'] })
    // Unknown top-level keys and unrelated siblings survive.
    expect(out.model).toBe('opus')
    expect(out.customKey).toEqual({ keep: true })
  })

  test('adding an already-present rule is idempotent', () => {
    const out = parse(applyEdit(seed, { kind: 'permission', op: 'add', list: 'allow', rule: 'Read(*)' }))
    expect(out.permissions).toMatchObject({ allow: ['Read(*)'] })
  })

  test('removing the last rule of a list deletes the list key', () => {
    const out = parse(applyEdit(seed, { kind: 'permission', op: 'remove', list: 'deny', rule: 'Bash(rm)' }))
    expect(out.permissions).toEqual({ allow: ['Read(*)'] })
    expect((out.permissions as Record<string, unknown>).deny).toBeUndefined()
  })

  test('removing the last rule across all lists deletes the permissions key', () => {
    const oneRule = JSON.stringify({ other: 1, permissions: { ask: ['X'] } })
    const out = parse(applyEdit(oneRule, { kind: 'permission', op: 'remove', list: 'ask', rule: 'X' }))
    expect(out.permissions).toBeUndefined()
    expect(out.other).toBe(1)
  })

  test('rejects an empty rule', () => {
    expect(() => applyEdit(seed, { kind: 'permission', op: 'add', list: 'allow', rule: '  ' })).toThrow(
      ConfigEditError
    )
  })
})

describe('hook edit', () => {
  const seed = JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a.sh' }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command: 'keep.sh' }] }]
    }
  })

  test('adds a hook to an existing matcher group without touching other events', () => {
    const out = parse(
      applyEdit(seed, {
        kind: 'hook',
        op: 'add',
        event: 'PreToolUse',
        matcher: 'Bash',
        hookType: 'command',
        command: 'b.sh'
      })
    )
    const pre = (out.hooks as Record<string, unknown>).PreToolUse as unknown[]
    expect(pre).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'a.sh' }, { type: 'command', command: 'b.sh' }] }
    ])
    // The untouched event is preserved verbatim.
    expect((out.hooks as Record<string, unknown>).PostToolUse).toEqual([
      { hooks: [{ type: 'command', command: 'keep.sh' }] }
    ])
  })

  test('adds a new matcher group when none matches', () => {
    const out = parse(
      applyEdit(seed, {
        kind: 'hook',
        op: 'add',
        event: 'PreToolUse',
        matcher: 'Edit',
        hookType: 'command',
        command: 'c.sh'
      })
    )
    const pre = (out.hooks as Record<string, unknown>).PreToolUse as unknown[]
    expect(pre).toContainEqual({ matcher: 'Edit', hooks: [{ type: 'command', command: 'c.sh' }] })
    expect(pre).toHaveLength(2)
  })

  test('removes a single hook, dropping the emptied group and event', () => {
    const out = parse(
      applyEdit(seed, {
        kind: 'hook',
        op: 'remove',
        event: 'PreToolUse',
        matcher: 'Bash',
        hookType: 'command',
        command: 'a.sh'
      })
    )
    // PreToolUse had only that one hook, so the whole event disappears; PostToolUse survives.
    expect((out.hooks as Record<string, unknown>).PreToolUse).toBeUndefined()
    expect((out.hooks as Record<string, unknown>).PostToolUse).toBeDefined()
  })

  test('a no-matcher add matches a no-matcher group', () => {
    const out = parse(
      applyEdit(seed, {
        kind: 'hook',
        op: 'add',
        event: 'PostToolUse',
        matcher: null,
        hookType: 'command',
        command: 'more.sh'
      })
    )
    expect((out.hooks as Record<string, unknown>).PostToolUse).toEqual([
      { hooks: [{ type: 'command', command: 'keep.sh' }, { type: 'command', command: 'more.sh' }] }
    ])
  })
})

describe('mcp edit', () => {
  const seed = JSON.stringify({
    mcpServers: { keepme: { command: 'node', args: ['keep.js'] } },
    unrelated: true
  })

  test('sets a server while preserving other servers and unknown keys', () => {
    const out = parse(
      applyEdit(seed, {
        kind: 'mcp',
        op: 'set',
        name: 'added',
        server: '{"command":"npx","args":["x"]}'
      })
    )
    expect(out.mcpServers).toEqual({
      keepme: { command: 'node', args: ['keep.js'] },
      added: { command: 'npx', args: ['x'] }
    })
    expect(out.unrelated).toBe(true)
  })

  test('removing the last server deletes the mcpServers key', () => {
    const one = JSON.stringify({ mcpServers: { only: { command: 'x' } }, other: 1 })
    const out = parse(applyEdit(one, { kind: 'mcp', op: 'remove', name: 'only', server: '' }))
    expect(out.mcpServers).toBeUndefined()
    expect(out.other).toBe(1)
  })

  test('rejects a non-object server body', () => {
    expect(() =>
      applyEdit(seed, { kind: 'mcp', op: 'set', name: 'bad', server: '"just a string"' })
    ).toThrow(ConfigEditError)
  })
})

describe('advanced edit', () => {
  const seed = JSON.stringify({ model: 'opus', permissions: { allow: ['Read(*)'] } })

  test('sets a scalar key without disturbing managed slices', () => {
    const out = parse(applyEdit(seed, { kind: 'advanced', op: 'set', key: 'model', value: '"sonnet"' }))
    expect(out.model).toBe('sonnet')
    expect(out.permissions).toEqual({ allow: ['Read(*)'] })
  })

  test('removes a key', () => {
    const out = parse(applyEdit(seed, { kind: 'advanced', op: 'remove', key: 'model', value: '' }))
    expect(out.model).toBeUndefined()
  })

  test('refuses to touch a reserved slice key', () => {
    expect(() =>
      applyEdit(seed, { kind: 'advanced', op: 'set', key: 'permissions', value: '{}' })
    ).toThrow(/its own editor/)
  })

  test('rejects an invalid value payload', () => {
    expect(() =>
      applyEdit(seed, { kind: 'advanced', op: 'set', key: 'x', value: 'not json' })
    ).toThrow(ConfigEditError)
  })
})

describe('output format', () => {
  test('serializes with 2-space indent and a trailing newline', () => {
    const out = applyEdit('{}', { kind: 'advanced', op: 'set', key: 'a', value: '1' })
    expect(out).toBe('{\n  "a": 1\n}\n')
  })
})
