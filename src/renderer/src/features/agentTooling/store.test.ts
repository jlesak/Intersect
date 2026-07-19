import { beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  AgentCatalogItem,
  ConfigEditRequest,
  ConfigPreview,
  EffectiveConfig,
  SkillCatalogItem
} from '@common/domain'

const toastMocks = vi.hoisted(() => ({ push: vi.fn(), reportError: vi.fn() }))
vi.mock('./ipc')
vi.mock('@renderer/shared/ui/toast', () => ({
  reportError: toastMocks.reportError,
  useToastStore: { getState: () => ({ push: toastMocks.push }) }
}))
import * as api from './ipc'
import { reportError } from '@renderer/shared/ui/toast'
import { scopesEqual, useAgentToolingStore } from './store'

const mocked = vi.mocked(api)

const editRequest: ConfigEditRequest = {
  scope: { kind: 'global' },
  source: 'global',
  edit: { kind: 'permission', op: 'add', list: 'allow', rule: 'Bash(git status)' }
}

const preview = (over: Partial<ConfigPreview> = {}): ConfigPreview => ({
  scope: { kind: 'global' },
  source: 'global',
  path: '/home/u/.claude/settings.json',
  provenance: 'global · settings.json',
  exists: true,
  global: true,
  currentContent: '{}',
  proposedContent: '{\n  "permissions": {}\n}',
  revision: 'rev-1',
  valid: true,
  errors: [],
  ...over
})

const config = (over: Partial<EffectiveConfig> = {}): EffectiveConfig => ({
  scope: { kind: 'global' },
  adapter: 'claude-code',
  files: [],
  permissions: [],
  hooks: [],
  mcpServers: [],
  advanced: [],
  ...over
})

const skill = (name: string): SkillCatalogItem => ({
  name,
  source: { kind: 'user', label: 'User' },
  path: `/skills/${name}/SKILL.md`,
  description: '',
  external: false
})
const agent = (name: string): AgentCatalogItem => ({
  name,
  source: { kind: 'user', label: 'User' },
  path: `/agents/${name}.md`,
  description: '',
  model: '',
  tools: '',
  external: false
})

const reset = (): void =>
  useAgentToolingStore.setState(
    {
      adapter: 'claude-code',
      scope: { kind: 'global' },
      status: 'idle',
      error: null,
      config: null,
      skills: [],
      agents: [],
      pendingPreview: null,
      saving: false,
      lastUndo: null
    },
    false
  )

beforeEach(() => {
  reset()
  vi.clearAllMocks()
  mocked.getEffectiveConfig.mockResolvedValue(config())
  mocked.listSkills.mockResolvedValue([skill('alpha')])
  mocked.listAgents.mockResolvedValue([agent('reviewer')])
})

describe('load', () => {
  test('fetches config + both catalogs for the current scope and becomes ready', async () => {
    await useAgentToolingStore.getState().load()
    const s = useAgentToolingStore.getState()
    expect(s.status).toBe('ready')
    expect(s.skills.map((x) => x.name)).toEqual(['alpha'])
    expect(s.agents.map((x) => x.name)).toEqual(['reviewer'])
    expect(mocked.getEffectiveConfig).toHaveBeenCalledWith({ kind: 'global' })
  })

  test('records an error status and clears data when a fetch fails', async () => {
    mocked.listSkills.mockRejectedValue(new Error('disk gone'))
    await useAgentToolingStore.getState().load()
    const s = useAgentToolingStore.getState()
    expect(s.status).toBe('error')
    expect(s.error).toMatch(/disk gone/)
    expect(s.config).toBeNull()
  })
})

describe('setScope', () => {
  test('switches scope and refetches for the new scope', async () => {
    useAgentToolingStore.getState().setScope({ kind: 'project', projectId: 'p1' })
    expect(useAgentToolingStore.getState().scope).toEqual({ kind: 'project', projectId: 'p1' })
    // Let the triggered load settle.
    await Promise.resolve()
    await Promise.resolve()
    expect(mocked.getEffectiveConfig).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' })
  })

  test('re-selecting the same scope does not refetch', () => {
    useAgentToolingStore.getState().setScope({ kind: 'global' })
    expect(mocked.getEffectiveConfig).not.toHaveBeenCalled()
  })

  test('a stale in-flight load never overrides the latest scope selection', async () => {
    // First scope's config resolves late; the second scope resolves immediately.
    let resolveFirst: (v: EffectiveConfig) => void = () => {}
    mocked.getEffectiveConfig.mockImplementationOnce(
      () => new Promise<EffectiveConfig>((res) => (resolveFirst = res))
    )
    mocked.getEffectiveConfig.mockResolvedValueOnce(config({ scope: { kind: 'project', projectId: 'p2' } }))

    useAgentToolingStore.getState().setScope({ kind: 'project', projectId: 'p1' })
    useAgentToolingStore.getState().setScope({ kind: 'project', projectId: 'p2' })
    await Promise.resolve()
    await Promise.resolve()
    // The late first answer must not clobber the p2 result.
    resolveFirst(config({ scope: { kind: 'project', projectId: 'p1' } }))
    await Promise.resolve()
    await Promise.resolve()

    const s = useAgentToolingStore.getState()
    expect(s.scope).toEqual({ kind: 'project', projectId: 'p2' })
    expect(s.config?.scope).toEqual({ kind: 'project', projectId: 'p2' })
  })
})

describe('reveal', () => {
  test('delegates to the reveal IPC seam', async () => {
    mocked.revealPath.mockResolvedValue()
    await useAgentToolingStore.getState().reveal('/skills/alpha/SKILL.md')
    expect(mocked.revealPath).toHaveBeenCalledWith('/skills/alpha/SKILL.md')
  })

  test('a reveal failure toasts instead of throwing', async () => {
    mocked.revealPath.mockRejectedValue(new Error('blocked'))
    await useAgentToolingStore.getState().reveal('/etc/passwd')
    expect(reportError).toHaveBeenCalled()
  })
})

describe('preview', () => {
  test('stores the preview paired with its request for the confirm dialog', async () => {
    mocked.previewSave.mockResolvedValue(preview())
    await useAgentToolingStore.getState().preview(editRequest)
    const pending = useAgentToolingStore.getState().pendingPreview
    expect(mocked.previewSave).toHaveBeenCalledWith(editRequest)
    expect(pending?.request).toEqual(editRequest)
    expect(pending?.preview.revision).toBe('rev-1')
  })

  test('a preview failure toasts and leaves nothing pending', async () => {
    mocked.previewSave.mockRejectedValue(new Error('blocked'))
    await useAgentToolingStore.getState().preview(editRequest)
    expect(reportError).toHaveBeenCalled()
    expect(useAgentToolingStore.getState().pendingPreview).toBeNull()
  })
})

describe('commit', () => {
  test('commits under the preview revision, offers undo, and refetches', async () => {
    useAgentToolingStore.setState({ pendingPreview: { request: editRequest, preview: preview() } }, false)
    mocked.commitSave.mockResolvedValue({
      ok: true,
      path: '/home/u/.claude/settings.json',
      backupPath: '/home/u/.claude/settings.json.bak.20260719-101112',
      newRevision: 'rev-2'
    })
    await useAgentToolingStore.getState().commit()
    const s = useAgentToolingStore.getState()
    expect(mocked.commitSave).toHaveBeenCalledWith({ ...editRequest, revision: 'rev-1' })
    expect(s.pendingPreview).toBeNull()
    expect(s.lastUndo).toEqual({
      path: '/home/u/.claude/settings.json',
      backupPath: '/home/u/.claude/settings.json.bak.20260719-101112'
    })
    expect(mocked.getEffectiveConfig).toHaveBeenCalled()
  })

  test('a rejected save clears the preview, offers no undo, and warns', async () => {
    useAgentToolingStore.setState({ pendingPreview: { request: editRequest, preview: preview() } }, false)
    mocked.commitSave.mockResolvedValue({
      ok: false,
      path: '/home/u/.claude/settings.json',
      reason: 'changed-externally'
    })
    await useAgentToolingStore.getState().commit()
    const s = useAgentToolingStore.getState()
    expect(s.pendingPreview).toBeNull()
    expect(s.lastUndo).toBeNull()
    expect(toastMocks.push).toHaveBeenCalled()
  })

  test('never commits an invalid preview', async () => {
    useAgentToolingStore.setState(
      { pendingPreview: { request: editRequest, preview: preview({ valid: false, errors: ['bad'] }) } },
      false
    )
    await useAgentToolingStore.getState().commit()
    expect(mocked.commitSave).not.toHaveBeenCalled()
  })
})

describe('undo', () => {
  test('undoes the last save, clears the affordance, and refetches', async () => {
    useAgentToolingStore.setState({ lastUndo: { path: '/home/u/.claude/settings.json' } }, false)
    mocked.undoSave.mockResolvedValue({ ok: true, restoredRevision: 'rev-1' })
    await useAgentToolingStore.getState().undo()
    const s = useAgentToolingStore.getState()
    expect(mocked.undoSave).toHaveBeenCalledWith('/home/u/.claude/settings.json')
    expect(s.lastUndo).toBeNull()
    expect(mocked.getEffectiveConfig).toHaveBeenCalled()
  })

  test('a rejected undo keeps the affordance and warns', async () => {
    useAgentToolingStore.setState({ lastUndo: { path: '/home/u/.claude/settings.json' } }, false)
    mocked.undoSave.mockResolvedValue({ ok: false, reason: 'changed-since-save' })
    await useAgentToolingStore.getState().undo()
    expect(useAgentToolingStore.getState().lastUndo).not.toBeNull()
    expect(toastMocks.push).toHaveBeenCalled()
  })
})

describe('scopesEqual', () => {
  test('compares kind and project id', () => {
    expect(scopesEqual({ kind: 'global' }, { kind: 'global' })).toBe(true)
    expect(scopesEqual({ kind: 'global' }, { kind: 'project', projectId: 'p1' })).toBe(false)
    expect(
      scopesEqual({ kind: 'project', projectId: 'p1' }, { kind: 'project', projectId: 'p1' })
    ).toBe(true)
    expect(
      scopesEqual({ kind: 'project', projectId: 'p1' }, { kind: 'project', projectId: 'p2' })
    ).toBe(false)
  })
})
