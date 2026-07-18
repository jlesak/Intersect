import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { AgentToolingScope, EffectiveConfig, SkillCatalogItem } from '@common/domain'
import { AgentToolingPaneBody } from './AgentToolingPane'

// Vitest transforms TSX without the renderer's Vite React plugin, so provide the classic JSX
// runtime explicitly for the imported production component.
vi.stubGlobal('React', React)

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

const render = (
  over: Partial<React.ComponentProps<typeof AgentToolingPaneBody>> = {}
): HTMLDivElement => {
  const host = document.createElement('div')
  const props: React.ComponentProps<typeof AgentToolingPaneBody> = {
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
  }
  host.innerHTML = renderToStaticMarkup(React.createElement(AgentToolingPaneBody, props))
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
})
