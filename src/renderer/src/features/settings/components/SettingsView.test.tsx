import { act, cleanup, fireEvent, render as renderClient } from '@testing-library/react'
import { afterEach, describe, expect, test, vi, type Mock } from 'vitest'
import {
  DEFAULT_PR_REVIEW_PROMPT,
  type AppSettings,
  type EffectiveConfig,
  type RawTargetView
} from '@common/domain'
import { SettingsView } from './SettingsView'

// Monaco cannot run under jsdom and must stay out of every bundle a test can reach, so the raw
// editor is driven through its stand-in.
vi.mock('@renderer/features/agentTooling/components/RawJsonEditor', async () => ({
  RawJsonEditor: (
    await import('@renderer/features/agentTooling/components/rawEditorTestkit')
  ).RawJsonEditorStub
}))

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

/**
 * Clears what the Agent Tooling store carries between tests, the parked raw edit above all.
 * The barrel is imported here rather than at the top of the file: this suite mocks it, and a
 * top-level import would hand the settings view the namespace as it stood before that mock was
 * finished, leaving it with no pane to render.
 */
async function resetAgentTooling(): Promise<void> {
  const { useAgentToolingStore } = await import('@renderer/features/agentTooling')
  useAgentToolingStore.setState({
    status: 'idle',
    error: null,
    config: null,
    skills: [],
    agents: [],
    rawDrafts: {}
  })
}

/** What `readRaw` answers with; a test moves it to play the file changing underneath an edit. */
let onDisk: RawTargetView = {
  scope: { kind: 'global' },
  source: 'global',
  path: '/home/.claude/settings.json',
  exists: true,
  global: true,
  content: '{}',
  revision: 'rev-1'
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
function installIpc(): Record<
  'getEffectiveConfig' | 'listSkills' | 'listAgents' | 'readRaw',
  Mock
> {
  const agentTooling = {
    getEffectiveConfig: vi.fn(() => Promise.resolve(EMPTY_CONFIG)),
    listSkills: vi.fn(() => Promise.resolve([])),
    listAgents: vi.fn(() => Promise.resolve([])),
    readRaw: vi.fn(() => Promise.resolve(onDisk))
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

/** Clicks a button anywhere in the settings body by its exact label. */
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

/** Lets a lazily imported editor and the reads behind it settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** Waits for the raw editor to finish loading lazily and reading its file. */
async function waitForRawEditor(): Promise<HTMLTextAreaElement> {
  for (let i = 0; i < 20 && !rawEditor(); i++) await settle()
  const box = rawEditor()
  if (!box) throw new Error('the raw editor never opened')
  return box
}

describe('SettingsView', () => {
  afterEach(async () => {
    agentToolingThrows = false
    delete (window as { intersect?: unknown }).intersect
    onDisk = { ...onDisk, content: '{}', revision: 'rev-1' }
    await resetAgentTooling()
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

/**
 * The hand-edited settings document is the most expensive thing the app holds in memory and the
 * one the user cannot retype, so it has to outlive the category nav. Only the selected pane is
 * mounted, which means switching category disposes the editor outright.
 */
describe('an unsaved raw JSON edit across a Settings category switch', () => {
  afterEach(async () => {
    delete (window as { intersect?: unknown }).intersect
    onDisk = { ...onDisk, content: '{}', revision: 'rev-1' }
    await resetAgentTooling()
  })

  /** Opens Agent Tooling -> Advanced -> the raw editor and types `text` into it. */
  async function typeRawEdit(text: string): Promise<void> {
    await selectCategory('Agent Tooling')
    await clickButton('Advanced')
    await clickButton('Edit raw JSON…')
    const box = await waitForRawEditor()
    await act(async () => {
      fireEvent.change(box, { target: { value: text } })
    })
  }

  test('the edit comes back, on the tab and in the file it was made in', async () => {
    installIpc()
    await renderSettings()
    await typeRawEdit('{ "model": "opus" }')

    await selectCategory('Vzhled')
    expect(rawEditor()).toBeNull()

    await selectCategory('Agent Tooling')
    await waitForRawEditor()

    // No clicks in between: the pane reopens on Advanced with the edited file loaded, because a
    // restored buffer the user cannot see is the same loss with extra steps.
    expect(rawEditor()?.value).toBe('{ "model": "opus" }')
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Advanced'
    )
  })

  test('a file that changed on disk meanwhile keeps the edit and says so', async () => {
    installIpc()
    await renderSettings()
    await typeRawEdit('{ "model": "opus" }')

    await selectCategory('Vzhled')
    // Claude Code rewrote the same file while the edit was parked.
    onDisk = { ...onDisk, content: '{ "model": "sonnet" }', revision: 'rev-2' }
    await selectCategory('Agent Tooling')
    await waitForRawEditor()

    expect(rawEditor()?.value).toBe('{ "model": "opus" }')
    const notice = document.querySelector('.ix-at-stale')?.textContent ?? ''
    expect(notice).toContain('changed on disk')
  })

  test('a file untouched on disk restores in silence, because nothing happened', async () => {
    installIpc()
    await renderSettings()
    await typeRawEdit('{ "model": "opus" }')

    await selectCategory('Vzhled')
    await selectCategory('Agent Tooling')
    await waitForRawEditor()

    expect(rawEditor()?.value).toBe('{ "model": "opus" }')
    expect(document.querySelector('.ix-at-stale')).toBeNull()
  })

  test('leaving Settings for an unrelated category marks where the unsaved edit is', async () => {
    installIpc()
    await renderSettings()
    await typeRawEdit('{ "model": "opus" }')

    await selectCategory('Vzhled')

    const marked = [...document.querySelectorAll('.ix-settings__nav-btn')].find((b) =>
      b.querySelector('.ix-settings__nav-dot')
    )
    expect(marked?.textContent).toContain('Agent Tooling')
  })

  test('Settings reopens on the category holding the unsaved edit', async () => {
    installIpc()
    await renderSettings()
    await typeRawEdit('{ "model": "opus" }')

    // Unmounting and mounting again is what a sidebar navigation away and back produces.
    cleanup()
    expect(document.querySelector('.ix-settings')).toBeNull()
    await renderSettings()
    await waitForRawEditor()

    expect(document.querySelector('.ix-settings__title')?.textContent).toBe('Agent Tooling')
    expect(rawEditor()?.value).toBe('{ "model": "opus" }')
  })
})
