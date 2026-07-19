import { describe, expect, test, vi } from 'vitest'
import type { AgentToolingScope } from '@common/domain'
import type { ClaudeConfigReader, ResolvedScope } from '../agentTooling/claudeConfigReader'
import type { ConfigWriter } from '../agentTooling/configWriter'
import { createAgentToolingHandlers } from './agentTooling.ipc'

function fakeReader(over: Partial<ClaudeConfigReader> = {}): ClaudeConfigReader {
  return {
    getEffectiveConfig: vi.fn(() => ({ files: [], permissions: [], hooks: [], mcpServers: [], advanced: [] })),
    listSkills: vi.fn(() => []),
    listAgents: vi.fn(() => []),
    ...over
  } as ClaudeConfigReader
}

function fakeWriter(over: Partial<ConfigWriter> = {}): ConfigWriter {
  return {
    readTarget: vi.fn(() => ({
      source: 'global',
      path: '/home/.claude/settings.json',
      exists: false,
      global: true,
      content: '',
      revision: 'absent'
    })),
    preview: vi.fn(() => ({
      source: 'global',
      path: '/home/.claude/settings.json',
      provenance: 'Global',
      exists: false,
      global: true,
      currentContent: '',
      proposedContent: '{}\n',
      revision: 'absent',
      valid: true,
      errors: []
    })),
    save: vi.fn(() => ({ ok: true, path: '/home/.claude/settings.json', newRevision: 'r1' })),
    undo: vi.fn(() => ({ ok: true, restoredRevision: 'absent' })),
    ...over
  } as ConfigWriter
}

const resolveScope = (scope: AgentToolingScope): ResolvedScope =>
  scope.kind === 'global'
    ? { kind: 'global' }
    : scope.projectId === 'p1'
      ? { kind: 'project', repoRoots: ['/repo'] }
      : (() => {
          throw new Error(`Project not found: ${scope.projectId}`)
        })()

const build = (over: { reader?: ClaudeConfigReader; writer?: ConfigWriter } = {}) =>
  createAgentToolingHandlers({
    reader: over.reader ?? fakeReader(),
    writer: over.writer ?? fakeWriter(),
    resolveScope
  })

describe('createAgentToolingHandlers', () => {
  test('getEffectiveConfig stamps the scope and adapter onto the reader result', async () => {
    const reader = fakeReader()
    const handlers = build({ reader })
    const result = await handlers.getEffectiveConfig({ kind: 'global' })
    expect(result.adapter).toBe('claude-code')
    expect(result.scope).toEqual({ kind: 'global' })
    expect(reader.getEffectiveConfig).toHaveBeenCalledWith({ kind: 'global' })
  })

  test('project scope resolves the id to its repository roots before reading', async () => {
    const reader = fakeReader()
    const handlers = build({ reader })
    await handlers.listSkills({ kind: 'project', projectId: 'p1' })
    expect(reader.listSkills).toHaveBeenCalledWith({ kind: 'project', repoRoots: ['/repo'] })
  })

  test('an unknown project surfaces as a message-only Error', async () => {
    const handlers = build()
    await expect(handlers.listAgents({ kind: 'project', projectId: 'ghost' })).rejects.toThrow(
      'Project not found: ghost'
    )
  })

  test('a non-Error thrown by the reader is normalized to an Error', async () => {
    const reader = fakeReader({
      listSkills: vi.fn(() => {
        throw 'raw string failure'
      })
    })
    const handlers = build({ reader })
    await expect(handlers.listSkills({ kind: 'global' })).rejects.toThrow('raw string failure')
  })

  test('readRaw resolves the scope and stamps it onto the writer view', async () => {
    const writer = fakeWriter()
    const handlers = build({ writer })
    const view = await handlers.readRaw({ kind: 'project', projectId: 'p1' }, 'project')
    expect(writer.readTarget).toHaveBeenCalledWith({ kind: 'project', repoRoots: ['/repo'] }, 'project')
    expect(view.scope).toEqual({ kind: 'project', projectId: 'p1' })
  })

  test('previewSave passes the resolved scope + edit and stamps the renderer scope back', async () => {
    const writer = fakeWriter()
    const handlers = build({ writer })
    const edit = { kind: 'advanced', op: 'set', key: 'model', value: '"opus"' } as const
    const preview = await handlers.previewSave({ scope: { kind: 'global' }, source: 'global', edit })
    expect(writer.preview).toHaveBeenCalledWith({ kind: 'global' }, 'global', edit)
    expect(preview.scope).toEqual({ kind: 'global' })
  })

  test('commitSave forwards the revision to the writer', async () => {
    const writer = fakeWriter()
    const handlers = build({ writer })
    const edit = { kind: 'raw', content: '{}\n' } as const
    await handlers.commitSave({ scope: { kind: 'global' }, source: 'global', edit, revision: 'r0' })
    expect(writer.save).toHaveBeenCalledWith({ kind: 'global' }, 'global', edit, 'r0')
  })

  test('undoSave delegates the target path straight through', async () => {
    const writer = fakeWriter()
    const handlers = build({ writer })
    await handlers.undoSave('/home/.claude/settings.json')
    expect(writer.undo).toHaveBeenCalledWith('/home/.claude/settings.json')
  })
})
