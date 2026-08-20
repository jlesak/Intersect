import { act, fireEvent, render as renderClient } from '@testing-library/react'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type {
  AgentCatalogItem,
  AgentToolingScope,
  EffectiveConfig,
  SkillCatalogItem
} from '@common/domain'
import { useProjectsStore } from '@renderer/features/projects'
import { selectRawDraft, useAgentToolingStore } from '../store'
import { AgentToolingPane, AgentToolingPaneBody } from './AgentToolingPane'

// Monaco cannot run under jsdom and must stay out of every bundle a test can reach, so the raw
// editor is driven through its stand-in.
vi.mock('./RawJsonEditor', async () => ({
  RawJsonEditor: (await import('./rawEditorTestkit')).RawJsonEditorStub
}))

const config: EffectiveConfig = {
  scope: { kind: 'global' },
  adapter: 'claude-code',
  files: [
    { source: 'global', path: '/home/.claude/settings.json', exists: true, error: null },
    { source: 'global-local', path: '/home/.claude/settings.local.json', exists: false, error: null }
  ],
  permissions: [{ list: 'allow', rule: 'Read(*)', source: 'global' }],
  hooks: [],
  mcpServers: [],
  advanced: [{ key: 'model', value: '"opus"', source: 'global' }]
}

const noop = (): void => {}

const propsWith = (
  over: Partial<React.ComponentProps<typeof AgentToolingPaneBody>>
): React.ComponentProps<typeof AgentToolingPaneBody> => ({
  status: 'ready',
  error: null,
  scope: { kind: 'global' } as AgentToolingScope,
  config,
  skills: [],
  agents: [],
  projects: [{ id: 'p1', name: 'SPOT' }],
  onScopeChange: noop,
  onReveal: noop,
  ...over
})

const render = (
  over: Partial<React.ComponentProps<typeof AgentToolingPaneBody>> = {}
): HTMLDivElement => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(React.createElement(AgentToolingPaneBody, propsWith(over)))
  return host
}

describe('AgentToolingPaneBody', () => {
  test('renders the fixed sub-navigation in information-architecture order', () => {
    const host = render()
    const tabs = [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)
    expect(tabs).toEqual(['Overview', 'Permissions', 'Hooks', 'MCP', 'Skills', 'Agents', 'Advanced'])
  })

  test('exposes the adapter and scope selectors, with Global plus each active project', () => {
    const host = render()
    const adapter = host.querySelector<HTMLSelectElement>('select[aria-label="Adapter"]')
    expect(adapter?.getAttribute('disabled')).not.toBeNull()

    const scope = host.querySelector('select[aria-label="Scope"]')
    const options = [...(scope?.querySelectorAll('option') ?? [])].map((o) => o.textContent)
    expect(options).toEqual(['Global (~/.claude)', 'SPOT'])
  })

  test('reflects the selected scope in the scope selector value', () => {
    const host = render({ scope: { kind: 'project', projectId: 'p1' } })
    const scope = host.querySelector<HTMLSelectElement>('select[aria-label="Scope"]')
    // The selected option carries the project value.
    const selected = scope?.querySelector('option[selected]')
    expect(selected?.getAttribute('value')).toBe('project:p1')
  })

  test('keeps provenance visible - the overview shows source badges and file states', () => {
    const host = render()
    const badges = [...host.querySelectorAll('.ix-at-badge')].map((b) => b.textContent)
    expect(badges).toContain('global')
    expect(badges).toContain('project')
    expect(host.querySelector('.ix-at-filestate--present')).toBeTruthy()
    expect(host.querySelector('.ix-at-filestate--absent')).toBeTruthy()
  })

  test('renders a loading state', () => {
    const host = render({ status: 'loading', config: null })
    expect(host.textContent).toContain('Loading…')
  })

  test('renders an error state with the message', () => {
    const host = render({ status: 'error', error: 'boom', config: null })
    expect(host.textContent).toContain('Could not read the configuration')
    expect(host.textContent).toContain('boom')
  })

  test('a malformed config file surfaces its per-file diagnostic in the overview', () => {
    const host = render({
      config: {
        ...config,
        files: [{ source: 'project', path: '/repo/.claude/settings.json', exists: true, error: 'Invalid JSON: x' }]
      }
    })
    expect(host.querySelector('.ix-at-filestate--malformed')).toBeTruthy()
    expect(host.textContent).toContain('Invalid JSON: x')
  })

  test('the overview counts reflect the discovered skills and agents', () => {
    const skills: SkillCatalogItem[] = [
      {
        name: 'brainstorm',
        source: { kind: 'plugin', label: 'super@official' },
        path: '/plugins/super/skills/brainstorm/SKILL.md',
        description: 'plugin skill',
        external: true
      }
    ]
    const host = render({ skills })
    const skillTile = [...host.querySelectorAll('.ix-at-count')].find(
      (c) => c.querySelector('.ix-at-count__label')?.textContent === 'Skills'
    )
    expect(skillTile?.querySelector('.ix-at-count__value')?.textContent).toBe('1')
  })

  test('is strictly read-only without onEdit: no add or remove controls', () => {
    const host = render({ initialTab: 'permissions' })
    expect(host.querySelector('.ix-at-add')).toBeNull()
    expect(host.querySelector('.ix-at-remove')).toBeNull()
    // The effective rule is still shown.
    expect(host.textContent).toContain('Read(*)')
  })

  test('with onEdit, the permissions editor exposes add rows and a remove for a same-source rule', () => {
    const host = render({ initialTab: 'permissions', onEdit: noop })
    // One add input per allow / deny / ask list.
    expect(host.querySelectorAll('.ix-at-add').length).toBe(3)
    expect(host.querySelector('[aria-label="Add allow rule"]')).toBeTruthy()
    // The Read(*) rule is sourced from the global settings file, the edit target for global scope,
    // so it can be removed.
    expect(host.querySelector('.ix-at-remove')).toBeTruthy()
    expect(host.querySelector('.ix-at-targetnote')?.textContent).toContain('global')
  })

  test('with onEdit, a rule from a non-target layer shows no remove control', () => {
    const host = render({
      initialTab: 'permissions',
      onEdit: noop,
      config: { ...config, permissions: [{ list: 'allow', rule: 'Read(*)', source: 'global-local' }] }
    })
    // The rule lives in settings.local.json, not the structured edit target, so no inline remove.
    expect(host.querySelector('.ix-at-remove')).toBeNull()
    // Add controls are still available.
    expect(host.querySelectorAll('.ix-at-add').length).toBe(3)
  })
})

/**
 * Both catalogs hand their searchable fields to the shared matcher in priority order, and the
 * matcher charges a hit for every field it sits past the first. These tests pin the priority each
 * catalog asked for: what the user is reading outranks the metadata beside it.
 */
describe('catalog search ranking', () => {
  const skill = (over: Partial<SkillCatalogItem>): SkillCatalogItem => ({
    name: 'skill',
    source: { kind: 'user', label: 'User' },
    path: '/home/.claude/skills/skill/SKILL.md',
    description: '',
    external: false,
    ...over
  })

  const agent = (over: Partial<AgentCatalogItem>): AgentCatalogItem => ({
    name: 'agent',
    source: { kind: 'user', label: 'User' },
    path: '/home/.claude/agents/agent.md',
    description: '',
    model: '',
    tools: '',
    external: false,
    ...over
  })

  /** Types a query into one catalog's search box and reads back the item names it leaves, in order. */
  function searchNames(
    over: Partial<React.ComponentProps<typeof AgentToolingPaneBody>>,
    searchLabel: string,
    query: string
  ): string[] {
    const { container } = renderClient(<AgentToolingPaneBody {...propsWith(over)} />)
    const box = container.querySelector<HTMLInputElement>(`input[aria-label="${searchLabel}"]`)!
    fireEvent.change(box, { target: { value: query } })
    return [...container.querySelectorAll('.ix-at-item__name')].map((n) => n.textContent ?? '')
  }

  test('a skill named for the query outranks one whose scope badge merely reads the same', () => {
    // Both hits are identical in shape - "user" starts the text and runs whole - so only the field
    // that carried them differs: the name the user is recalling against the scope badge beside it.
    const skills = [
      skill({ name: 'brainstorming', description: 'Explore intent before implementation' }),
      skill({
        name: 'user-prefs',
        description: 'Records preferences',
        source: { kind: 'project', label: 'Project' }
      })
    ]
    expect(searchNames({ initialTab: 'skills', skills }, 'Search skills', 'user')).toEqual([
      'user-prefs',
      'brainstorming'
    ])
  })

  test('an agent named for the query leads, and one that only lists it as a tool trails', () => {
    // Every tools line is a comma list of generic verbs, so a short query hits almost all of them.
    // All three hits below start their text and run whole; the field order decides.
    const agents = [
      agent({ name: 'planner', description: 'Plans the work', tools: 'Read, Bash' }),
      agent({ name: 'triage', description: 'Reads open pull requests', tools: 'Write, Bash' }),
      agent({
        name: 'reader',
        description: 'Summarises a file',
        tools: 'Grep',
        source: { kind: 'project', label: 'Project' }
      })
    ]
    expect(searchNames({ initialTab: 'agents', agents }, 'Search agents', 'read')).toEqual([
      'reader',
      'triage',
      'planner'
    ])
  })
})

/**
 * The store-reading container, mounted client-side. Static markup cannot expose a re-render loop,
 * so only a real root exercises how the pane subscribes to the projects slice.
 */
describe('AgentToolingPane container', () => {
  afterEach(() => {
    delete (window as { intersect?: unknown }).intersect
    useProjectsStore.setState({ status: 'idle', error: null, projects: [], overrides: [] })
    useAgentToolingStore.setState({ status: 'idle', error: null, config: null, skills: [], agents: [] })
  })

  /** The bridge calls the container makes on mount, so a client render can reach a ready state. */
  function stubBridge(): void {
    ;(window as { intersect?: unknown }).intersect = {
      projects: {
        list: () => Promise.resolve([{ id: 'p1', name: 'SPOT', archived: false }]),
        listOverrides: () => Promise.resolve([])
      },
      agentTooling: {
        getEffectiveConfig: () => Promise.resolve(config),
        listSkills: () => Promise.resolve([]),
        listAgents: () => Promise.resolve([])
      }
    }
  }

  test('mounts and settles without a render loop', async () => {
    stubBridge()
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        renderClient(<AgentToolingPane />)
      })

      expect(logged).toEqual([])
      expect(document.querySelector('.ix-at-scopebar')).toBeTruthy()
      expect(document.querySelector('select[aria-label="Scope"]')).toBeTruthy()
    } finally {
      consoleError.mockRestore()
    }
  })

  test('offers the loaded active projects as scopes', async () => {
    stubBridge()
    await act(async () => {
      renderClient(<AgentToolingPane />)
    })

    const scope = document.querySelector<HTMLSelectElement>('select[aria-label="Scope"]')
    const options = [...(scope?.querySelectorAll('option') ?? [])].map((o) => o.textContent)
    expect(options).toEqual(['Global (~/.claude)', 'SPOT'])
  })
})

/**
 * The raw editor holds a whole hand-edited settings document. Two of the ways to lose it never
 * unmount anything: changing the file selector re-runs the read that built the buffer, and
 * reloading replaces it on purpose. The first has to keep every file's edit, the second is the
 * only action allowed to throw one away.
 */
describe('the raw editor buffer', () => {
  const files: Record<string, string> = {
    global: '{ "model": "opus" }',
    'global-local': '{ "verbose": true }'
  }

  afterEach(() => {
    delete (window as { intersect?: unknown }).intersect
    useProjectsStore.setState({ status: 'idle', error: null, projects: [], overrides: [] })
    useAgentToolingStore.setState({
      status: 'idle',
      error: null,
      config: null,
      skills: [],
      agents: [],
      rawDrafts: {}
    })
  })

  function stubBridge(): void {
    ;(window as { intersect?: unknown }).intersect = {
      projects: { list: () => Promise.resolve([]), listOverrides: () => Promise.resolve([]) },
      agentTooling: {
        getEffectiveConfig: () => Promise.resolve(config),
        listSkills: () => Promise.resolve([]),
        listAgents: () => Promise.resolve([]),
        readRaw: (scope: AgentToolingScope, source: string) =>
          Promise.resolve({
            scope,
            source,
            path: `/home/.claude/${source}.json`,
            exists: true,
            global: true,
            content: files[source] ?? '{}',
            revision: `rev-${source}`
          })
      }
    }
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  async function clickButton(label: string): Promise<void> {
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === label
    )
    if (!button) throw new Error(`no button labelled "${label}"`)
    await act(async () => {
      fireEvent.click(button)
    })
  }

  const rawEditor = (): HTMLTextAreaElement | null =>
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Raw JSON"]')

  async function waitForRawEditor(): Promise<HTMLTextAreaElement> {
    for (let i = 0; i < 20 && !rawEditor(); i++) await settle()
    const box = rawEditor()
    if (!box) throw new Error('the raw editor never opened')
    return box
  }

  /** Mounts the pane and opens the raw editor on the Advanced tab. */
  async function openRawEditor(): Promise<HTMLTextAreaElement> {
    stubBridge()
    await act(async () => {
      renderClient(<AgentToolingPane />)
    })
    await clickButton('Advanced')
    await clickButton('Edit raw JSON…')
    return waitForRawEditor()
  }

  async function type(text: string): Promise<void> {
    await act(async () => {
      fireEvent.change(rawEditor()!, { target: { value: text } })
    })
  }

  async function selectFile(label: string): Promise<void> {
    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Raw editor target file"]'
    )!
    await act(async () => {
      fireEvent.change(select, { target: { value: label } })
    })
    await waitForRawEditor()
  }

  test('each layered file keeps its own edit as the selector moves between them', async () => {
    await openRawEditor()
    await type('{ "model": "haiku" }')

    await selectFile('global-local')
    expect(rawEditor()?.value).toBe('{ "verbose": true }')
    await type('{ "verbose": false }')

    await selectFile('global')
    expect(rawEditor()?.value).toBe('{ "model": "haiku" }')
    await selectFile('global-local')
    expect(rawEditor()?.value).toBe('{ "verbose": false }')
  })

  /** The file the panel is pointed at, which is the file its buffer belongs to. */
  const targetFile = (): string =>
    document.querySelector<HTMLSelectElement>('select[aria-label="Raw editor target file"]')!.value

  test('reopening the editor comes back to the file the edit was parked for', async () => {
    await openRawEditor()
    await selectFile('global-local')
    await type('{ "verbose": false }')

    await clickButton('Close raw JSON editor')
    await clickButton('Edit raw JSON…')
    await waitForRawEditor()

    expect(targetFile()).toBe('global-local')
    expect(rawEditor()?.value).toBe('{ "verbose": false }')
  })

  test('typing back to what the file holds leaves nothing parked', async () => {
    await openRawEditor()
    await type('{ "model": "haiku" }')
    await type(files.global)

    expect(selectRawDraft(useAgentToolingStore.getState(), { kind: 'global' }, 'global')).toBeNull()
  })

  test('reloading asks first, and keeps the edit when the answer is no', async () => {
    await openRawEditor()
    await type('{ "model": "haiku" }')

    await clickButton('Reload from disk')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Discard')

    await clickButton('Keep editing')
    expect(rawEditor()?.value).toBe('{ "model": "haiku" }')
    expect(
      selectRawDraft(useAgentToolingStore.getState(), { kind: 'global' }, 'global')
    ).not.toBeNull()
  })

  test('reloading drops the edit once the user confirms it', async () => {
    await openRawEditor()
    await type('{ "model": "haiku" }')

    await clickButton('Reload from disk')
    await clickButton('Discard and reload')
    await waitForRawEditor()

    expect(rawEditor()?.value).toBe(files.global)
    expect(selectRawDraft(useAgentToolingStore.getState(), { kind: 'global' }, 'global')).toBeNull()
  })

  test('an untouched buffer reloads without a question', async () => {
    await openRawEditor()

    await clickButton('Reload from disk')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
