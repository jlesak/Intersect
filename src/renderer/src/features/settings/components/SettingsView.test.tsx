import { act, fireEvent, render as renderClient } from '@testing-library/react'
import { afterEach, describe, expect, test, vi, type Mock } from 'vitest'
import { DEFAULT_PR_REVIEW_PROMPT, type AppSettings, type EffectiveConfig } from '@common/domain'
import { SettingsView } from './SettingsView'

/**
 * Flipped by the containment test only. The pane has to fail the way a real one would - from
 * inside React's render - and every other test here needs the genuine pane, so the stub stands in
 * for the real component and defers to it unless this flag is set.
 */
let agentToolingThrows = false

vi.mock('@renderer/features/agentTooling', async () => {
  const actual =
    await vi.importActual<typeof import('@renderer/features/agentTooling')>(
      '@renderer/features/agentTooling'
    )
  const RealPane = actual.AgentToolingPane
  return {
    ...actual,
    AgentToolingPane: function AgentToolingPaneStub() {
      if (agentToolingThrows) throw new Error('agent tooling pane exploded')
      return <RealPane />
    }
  }
})

const SETTINGS: AppSettings = {
  notifications: { enabled: true, working: false, waiting: true, done: true, sound: true },
  ado: { orgUrl: '', project: '', repository: '', pat: '' },
  adoFallback: { orgUrl: '', project: '', hasPat: false },
  appearance: { terminalFontSize: 12.5 },
  review: { prompt: DEFAULT_PR_REVIEW_PROMPT },
  session: { autoResume: true }
}

const EMPTY_CONFIG: EffectiveConfig = {
  scope: { kind: 'global' },
  adapter: 'claude-code',
  files: [],
  permissions: [],
  hooks: [],
  mcpServers: [],
  advanced: []
}

const CATEGORY_LABELS = [
  'Projekty',
  'Agent Tooling',
  'Notifikace',
  'Azure DevOps',
  'PR Review',
  'Sessions',
  'Klávesové zkratky',
  'Vzhled'
]

/**
 * Install the preload bridge every pane reads through. The Agent Tooling calls are returned so a
 * test can assert whether that pane's mount effect ran at all - they are the expensive ones, each
 * a synchronous filesystem walk in the main process.
 */
function installIpc(): Record<'getEffectiveConfig' | 'listSkills' | 'listAgents', Mock> {
  const agentTooling = {
    getEffectiveConfig: vi.fn(() => Promise.resolve(EMPTY_CONFIG)),
    listSkills: vi.fn(() => Promise.resolve([])),
    listAgents: vi.fn(() => Promise.resolve([]))
  }
  ;(window as { intersect?: unknown }).intersect = {
    settings: { get: () => Promise.resolve(SETTINGS) },
    projects: { list: () => Promise.resolve([]), listOverrides: () => Promise.resolve([]) },
    agentTooling
  }
  return agentTooling
}

async function renderSettings(): Promise<void> {
  await act(async () => {
    renderClient(<SettingsView />)
  })
}

async function selectCategory(label: string): Promise<void> {
  const button = [...document.querySelectorAll('.ix-settings__nav-btn')].find(
    (b) => b.textContent === label
  )
  if (!button) throw new Error(`no settings category button labelled "${label}"`)
  await act(async () => {
    fireEvent.click(button)
  })
}

describe('SettingsView', () => {
  afterEach(() => {
    agentToolingThrows = false
    delete (window as { intersect?: unknown }).intersect
  })

  test('mounts only the active category pane', async () => {
    installIpc()
    await renderSettings()

    expect(document.querySelectorAll('.ix-settings__pane').length).toBe(1)
    expect(document.querySelector('.ix-settings__title')?.textContent).toBe('Projekty')
    expect(document.querySelectorAll('.ix-settings__nav-btn').length).toBe(8)
  })

  test('an unvisited pane never runs its mount effect', async () => {
    const agentTooling = installIpc()
    await renderSettings()

    expect(agentTooling.getEffectiveConfig).not.toHaveBeenCalled()
    expect(agentTooling.listSkills).not.toHaveBeenCalled()
    expect(agentTooling.listAgents).not.toHaveBeenCalled()

    await selectCategory('Agent Tooling')

    expect(agentTooling.getEffectiveConfig).toHaveBeenCalledTimes(1)
    expect(agentTooling.listSkills).toHaveBeenCalledTimes(1)
    expect(agentTooling.listAgents).toHaveBeenCalledTimes(1)
  })

  test('switching category unmounts the previous pane', async () => {
    installIpc()
    await renderSettings()
    await selectCategory('Agent Tooling')
    expect(document.querySelector('.ix-at-scopebar')).toBeTruthy()

    await selectCategory('Vzhled')

    expect(document.querySelector('.ix-at-scopebar')).toBeNull()
    expect(document.querySelector('#ix-set-font-size')).toBeTruthy()
  })

  test('a pane that throws is contained to the settings body', async () => {
    installIpc()
    agentToolingThrows = true
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await renderSettings()
      await selectCategory('Agent Tooling')

      expect(document.querySelector('.ix-crash--region')).toBeTruthy()
      expect(document.querySelectorAll('.ix-settings__nav-btn').length).toBe(8)

      // Those eight buttons are the way out of a crashed pane, so the fallback names them. The
      // sidebar would send the user out of Settings altogether, which is a longer way round.
      const card = document.querySelector('.ix-crash__card')?.textContent ?? ''
      expect(card).toContain('Pick another category in the list on the left')
      expect(card).not.toContain('sidebar')

      // The failing pane is still rigged to throw, so reaching another category proves the crash
      // was left behind with it rather than sticking to the whole settings region.
      await selectCategory('Vzhled')

      expect(document.querySelector('.ix-crash--region')).toBeNull()
      expect(document.querySelector('#ix-set-font-size')).toBeTruthy()
    } finally {
      consoleError.mockRestore()
    }
  })

  test('renders an accessible multiline prompt editor and reset action', async () => {
    installIpc()
    await renderSettings()
    await selectCategory('PR Review')

    const navButton = [...document.querySelectorAll('.ix-settings__nav-btn')].find(
      (button) => button.textContent === 'PR Review'
    )
    const label = document.querySelector('label[for="ix-set-review-prompt"]')
    const textarea = document.querySelector<HTMLTextAreaElement>('#ix-set-review-prompt')
    const reset = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Obnovit výchozí prompt'
    )

    expect(navButton).toBeTruthy()
    expect(label?.textContent).toBe('Prompt pro AI review')
    expect(textarea?.getAttribute('aria-describedby')).toBe('ix-set-review-prompt-hint')
    expect(textarea?.value).toBe(DEFAULT_PR_REVIEW_PROMPT)
    expect(reset?.getAttribute('type')).toBe('button')
  })

  test('exposes a Sessions category with the auto-resume toggle', async () => {
    installIpc()
    await renderSettings()
    await selectCategory('Sessions')

    const navButton = [...document.querySelectorAll('.ix-settings__nav-btn')].find(
      (button) => button.textContent === 'Sessions'
    )
    const toggle = document.querySelector(
      'input[aria-label="Automaticky obnovit sessions po ukončení"]'
    )
    expect(navButton).toBeTruthy()
    expect(toggle).toBeTruthy()
  })

  /**
   * Only one pane is ever mounted, so no single render exercises them all. Walking the whole
   * sub-navigation is what still catches a pane whose store subscription or mount effect
   * destabilises the tree - a defect static markup cannot see.
   */
  test('every category pane mounts without a render loop or logged error', async () => {
    installIpc()
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })

    try {
      await renderSettings()
      expect(document.querySelector('.ix-settings')).toBeTruthy()
      expect(document.querySelectorAll('.ix-settings__nav-btn').length).toBe(8)

      for (const label of CATEGORY_LABELS) {
        await selectCategory(label)
        expect(document.querySelectorAll('.ix-settings__pane').length).toBe(1)
        // The pane rendered its own heading, so it did not bail out.
        expect(document.querySelector('.ix-settings__title')).toBeTruthy()
      }

      expect(logged).toEqual([])
    } finally {
      consoleError.mockRestore()
    }
  })
})
