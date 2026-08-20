import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_PR_REVIEW_PROMPT, type AppSettings, type EffectiveConfig } from '@common/domain'
import { registerSettingsFeature, SETTINGS_SECTION_ID } from '@renderer/features/settings'
import {
  __resetSidebarRegistryForTests,
  registerSidebarSection
} from '@renderer/shared/registries/sidebarRegistry'
import {
  CRASH_SETTLE_MS,
  markUnrecoveredCrash,
  readUnrecoveredCrash,
  reloadWindow
} from '@renderer/shared/recovery/bootRecovery'
import { App } from './App'
import { useShellStore } from './shellStore'

// A real reload would throw the document away mid-test; everything else in the module stays real.
vi.mock('@renderer/shared/recovery/bootRecovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/shared/recovery/bootRecovery')>()),
  reloadWindow: vi.fn()
}))

// Monaco cannot run under jsdom and must stay out of every bundle a test can reach, so the raw
// editor is driven through its stand-in.
vi.mock('@renderer/features/agentTooling/components/RawJsonEditor', async () => ({
  RawJsonEditor: (
    await import('@renderer/features/agentTooling/components/rawEditorTestkit')
  ).RawJsonEditorStub
}))

const Icon = () => <span />

function Healthy() {
  return <div className="ix-main ix-probe-healthy">healthy section</div>
}

function Crashing(): never {
  throw new Error('section render failed')
}

/**
 * The app shell around a crashing section: the whole point of the region boundary is that a broken
 * feature costs the user only the content area, never the navigation that gets them out of it.
 */
describe('App shell containment of a crashing main region', () => {
  beforeEach(() => {
    __resetSidebarRegistryForTests()
    registerSidebarSection({ id: 'healthy', order: 0, label: 'Healthy', icon: Icon, mainComponent: Healthy })
    registerSidebarSection({ id: 'broken', order: 1, label: 'Broken', icon: Icon, mainComponent: Crashing })
    // CoreStatusOverlay subscribes on mount; the rest of the shell only reads store defaults.
    ;(window as { intersect?: unknown }).intersect = {
      system: { onCoreStatus: () => () => {} }
    }
    useShellStore.setState({ context: { kind: 'section', id: 'broken' }, sidebarCollapsed: false })
  })

  afterEach(() => {
    __resetSidebarRegistryForTests()
    delete (window as { intersect?: unknown }).intersect
    useShellStore.setState({ context: null, sidebarCollapsed: false })
  })

  test('the crash is contained to the main region while the sidebar stays live', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(<App />)

      expect(document.querySelector('.ix-crash--region')).toBeTruthy()
      expect(document.querySelector('.ix-crash__reason')?.textContent).toBe('section render failed')
      // The navigation the user needs to escape with is untouched.
      const railLabels = [...document.querySelectorAll('.ix-rail__label')].map((e) => e.textContent)
      expect(railLabels).toContain('Healthy')
      expect(railLabels).toContain('Broken')
      // And the fallback points at that sidebar by name, because here it is what survived.
      expect(document.querySelector('.ix-crash__card')?.textContent).toContain(
        'Pick another project or section in the sidebar'
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  test('navigating to another context clears the fallback and mounts the new view', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(<App />)
      expect(document.querySelector('.ix-crash--region')).toBeTruthy()

      act(() => {
        useShellStore.getState().setActiveSection('healthy')
      })

      expect(document.querySelector('.ix-crash--region')).toBeNull()
      expect(document.querySelector('.ix-probe-healthy')?.textContent).toBe('healthy section')
    } finally {
      consoleError.mockRestore()
    }
  })
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
 * Leaving Settings for another sidebar section unmounts the whole settings tree, editor included.
 * It is a bare store call from a dozen places (the rail, the palette, an OS notification), so
 * nothing can intercept it, and a hand-edited settings document has to outlive it regardless.
 */
describe('an unsaved raw JSON edit across a sidebar navigation', () => {
  beforeEach(() => {
    __resetSidebarRegistryForTests()
    registerSidebarSection({
      id: 'healthy',
      order: 0,
      label: 'Healthy',
      icon: Icon,
      mainComponent: Healthy
    })
    registerSettingsFeature()
    ;(window as { intersect?: unknown }).intersect = {
      system: { onCoreStatus: () => () => {} },
      settings: { get: () => Promise.resolve(SETTINGS) },
      projects: { list: () => Promise.resolve([]), listOverrides: () => Promise.resolve([]) },
      agentTooling: {
        getEffectiveConfig: () => Promise.resolve(EMPTY_CONFIG),
        listSkills: () => Promise.resolve([]),
        listAgents: () => Promise.resolve([]),
        readRaw: () =>
          Promise.resolve({
            scope: { kind: 'global' },
            source: 'global',
            path: '/home/.claude/settings.json',
            exists: true,
            global: true,
            content: '{}',
            revision: 'rev-1'
          })
      }
    }
    useShellStore.setState({
      context: { kind: 'section', id: SETTINGS_SECTION_ID },
      sidebarCollapsed: false
    })
  })

  afterEach(async () => {
    __resetSidebarRegistryForTests()
    delete (window as { intersect?: unknown }).intersect
    useShellStore.setState({ context: null, sidebarCollapsed: false })
    // The barrel is imported here rather than at the top of the file: this suite mocks a module
    // inside that feature, and a top-level import would capture the namespace as it stood before
    // the mock was finished, leaving the settings tree with no pane to render.
    const { useAgentToolingStore } = await import('@renderer/features/agentTooling')
    useAgentToolingStore.setState({
      status: 'idle',
      error: null,
      config: null,
      skills: [],
      agents: [],
      rawDrafts: {}
    })
  })

  const rawEditor = (): HTMLTextAreaElement | null =>
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Raw JSON"]')

  async function clickButton(label: string): Promise<void> {
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === label
    )
    if (!button) throw new Error(`no button labelled "${label}"`)
    await act(async () => {
      fireEvent.click(button)
    })
  }

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

  test('the edit is still there after a trip through another section', async () => {
    await act(async () => {
      render(<App />)
    })
    await clickButton('Agent Tooling')
    await clickButton('Advanced')
    await clickButton('Edit raw JSON…')
    const box = await waitForRawEditor()
    await act(async () => {
      fireEvent.change(box, { target: { value: '{ "model": "opus" }' } })
    })

    // Exactly what the rail button, the command palette and a notification click all call.
    await act(async () => {
      useShellStore.getState().setActiveSection('healthy')
    })
    expect(document.querySelector('.ix-probe-healthy')).toBeTruthy()
    expect(rawEditor()).toBeNull()

    await act(async () => {
      useShellStore.getState().setActiveSection(SETTINGS_SECTION_ID)
    })
    await waitForRawEditor()

    expect(rawEditor()?.value).toBe('{ "model": "opus" }')
  })
})

/**
 * The clear rule behind the crash marker. A shell that merely mounts has proved nothing: the very
 * failures this exists to catch happen a moment after the tree comes up. Only a tree that stays
 * alive for the settle window earns the marker's withdrawal.
 */
describe('withdrawing the crash marker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.localStorage.clear()
    __resetSidebarRegistryForTests()
    registerSidebarSection({
      id: 'healthy',
      order: 0,
      label: 'Healthy',
      icon: Icon,
      mainComponent: Healthy
    })
    ;(window as { intersect?: unknown }).intersect = {
      system: { onCoreStatus: () => () => {} },
      projects: { list: () => Promise.resolve([]) }
    }
    useShellStore.setState({ context: { kind: 'section', id: 'healthy' }, sidebarCollapsed: false })
  })

  afterEach(() => {
    vi.useRealTimers()
    __resetSidebarRegistryForTests()
    delete (window as { intersect?: unknown }).intersect
    useShellStore.setState({ context: null, sidebarCollapsed: false, safeMode: false })
    window.localStorage.clear()
  })

  test('a shell that stays up past the settle window withdraws it', () => {
    markUnrecoveredCrash(Date.now())
    render(<App />)
    expect(readUnrecoveredCrash()).not.toBeNull()

    act(() => {
      vi.advanceTimersByTime(CRASH_SETTLE_MS)
    })

    expect(readUnrecoveredCrash()).toBeNull()
  })

  test('a shell that goes down inside the window leaves it standing', () => {
    markUnrecoveredCrash(Date.now())
    const { unmount } = render(<App />)

    act(() => {
      vi.advanceTimersByTime(CRASH_SETTLE_MS - 1)
    })
    unmount()
    act(() => {
      vi.advanceTimersByTime(CRASH_SETTLE_MS)
    })

    // Mounting and then throwing is exactly the shape of a crash on persisted state, so a marker
    // cleared on mount alone would disable the escalation for the case that most needs it.
    expect(readUnrecoveredCrash()).not.toBeNull()
  })
})

/**
 * Safe mode hides the crash rather than resolving it, so the session it produces must never pass
 * for a normal one.
 */
describe('the safe mode session', () => {
  let listProjects: ReturnType<typeof vi.fn>

  beforeEach(() => {
    __resetSidebarRegistryForTests()
    registerSidebarSection({
      id: 'healthy',
      order: 0,
      label: 'Healthy',
      icon: Icon,
      mainComponent: Healthy
    })
    listProjects = vi.fn(() => Promise.resolve([]))
    ;(window as { intersect?: unknown }).intersect = {
      system: { onCoreStatus: () => () => {} },
      projects: { list: listProjects }
    }
    useShellStore.setState({
      context: { kind: 'section', id: 'healthy' },
      sidebarCollapsed: false,
      safeMode: true
    })
  })

  afterEach(() => {
    __resetSidebarRegistryForTests()
    delete (window as { intersect?: unknown }).intersect
    useShellStore.setState({ context: null, sidebarCollapsed: false, safeMode: false })
    vi.mocked(reloadWindow).mockClear()
  })

  test('a banner names the state and keeps the way out in reach', () => {
    render(<App />)

    const banner = document.querySelector('.ix-safemode')
    expect(banner?.textContent).toContain('the saved session and workspace state were not restored')

    const exit = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Exit safe mode'
    )
    act(() => {
      exit?.click()
    })
    // Leaving is a plain reload: the request that produced this session was consumed at boot, so
    // the next launch is an ordinary one with nothing left to undo.
    expect(reloadWindow).toHaveBeenCalledOnce()
  })

  test('an ordinary session shows no banner', () => {
    useShellStore.setState({ safeMode: false })
    render(<App />)
    expect(document.querySelector('.ix-safemode')).toBeNull()
  })

  test('the rail offers no project pins and no Other bucket to fall back into', () => {
    render(<App />)

    const railLabels = [...document.querySelectorAll('.ix-rail__label')].map((e) => e.textContent)
    expect(railLabels).toContain('Healthy')
    expect(railLabels).not.toContain('Other')
    // The rail renders outside the shell's region boundary, so a project row that cannot be drawn
    // takes the whole window down on every boot. Safe mode does not read them at all.
    expect(listProjects).not.toHaveBeenCalled()
  })

  test('an ordinary session does load the projects the rail pins', async () => {
    useShellStore.setState({ safeMode: false })
    await act(async () => {
      render(<App />)
    })
    expect(listProjects).toHaveBeenCalled()
  })
})
