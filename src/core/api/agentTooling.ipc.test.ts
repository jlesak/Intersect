import { describe, expect, test, vi } from 'vitest'
import type { AgentToolingScope } from '@common/domain'
import type { ClaudeConfigReader, ResolvedScope } from '../agentTooling/claudeConfigReader'
import { createAgentToolingHandlers } from './agentTooling.ipc'

function fakeReader(over: Partial<ClaudeConfigReader> = {}): ClaudeConfigReader {
  return {
    getEffectiveConfig: vi.fn(() => ({ files: [], permissions: [], hooks: [], mcpServers: [], advanced: [] })),
    listSkills: vi.fn(() => []),
    listAgents: vi.fn(() => []),
    ...over
  } as ClaudeConfigReader
}

const resolveScope = (scope: AgentToolingScope): ResolvedScope =>
  scope.kind === 'global'
    ? { kind: 'global' }
    : scope.projectId === 'p1'
      ? { kind: 'project', repoRoots: ['/repo'] }
      : (() => {
          throw new Error(`Project not found: ${scope.projectId}`)
        })()

describe('createAgentToolingHandlers', () => {
  test('getEffectiveConfig stamps the scope and adapter onto the reader result', async () => {
    const reader = fakeReader()
    const handlers = createAgentToolingHandlers({ reader, resolveScope })
    const result = await handlers.getEffectiveConfig({ kind: 'global' })
    expect(result.adapter).toBe('claude-code')
    expect(result.scope).toEqual({ kind: 'global' })
    expect(reader.getEffectiveConfig).toHaveBeenCalledWith({ kind: 'global' })
  })

  test('project scope resolves the id to its repository roots before reading', async () => {
    const reader = fakeReader()
    const handlers = createAgentToolingHandlers({ reader, resolveScope })
    await handlers.listSkills({ kind: 'project', projectId: 'p1' })
    expect(reader.listSkills).toHaveBeenCalledWith({ kind: 'project', repoRoots: ['/repo'] })
  })

  test('an unknown project surfaces as a message-only Error', async () => {
    const handlers = createAgentToolingHandlers({ reader: fakeReader(), resolveScope })
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
    const handlers = createAgentToolingHandlers({ reader, resolveScope })
    await expect(handlers.listSkills({ kind: 'global' })).rejects.toThrow('raw string failure')
  })
})
