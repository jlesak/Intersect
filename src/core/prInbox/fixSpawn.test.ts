import { describe, expect, test } from 'vitest'
import { buildSpawn, type SpawnSpec } from '../pty/shell'
import { buildFixSpawnSpec, decorateTerminalSpec, FIX_PROMPT_ENV } from './fixSpawn'
import { SECRET_ENV_TOKENS } from './reviewSpawn'

const env = {
  SHELL: '/bin/zsh',
  PATH: '/usr/bin',
  AZURE_DEVOPS_EXT_PAT: 'ado-secret',
  GITHUB_TOKEN: 'gh-secret',
  ANTHROPIC_API_KEY: 'anthropic-key',
  CLAUDE_CODE_OAUTH_TOKEN: 'claude-token'
}

/** The spec an ordinary Claude tab gets, the way the session manager builds it. */
const claudeBase = (over: { shell?: string; resume?: string } = {}): SpawnSpec =>
  buildSpawn('claude', {
    shell: over.shell ?? '/bin/zsh',
    env,
    notifSettingsPath: '/user data/notif.json',
    resumeSessionId: over.resume ?? null,
    instanceId: 'ws-1:tab-1'
  })

const FIX = '/fix/intersect-app-pr501'
const isFixFolder = (cwd: string): boolean => cwd === FIX

describe('buildFixSpawnSpec', () => {
  test('scrubs secrets in both layers and keeps Claude auth', () => {
    const spec = buildFixSpawnSpec(claudeBase(), 'Fix these.')

    expect(spec.initialCommand).toMatch(/^for _iv in \$\(typeset \+x\); do /)
    expect(spec.initialCommand).toContain('unset $_iv')
    expect(spec.env.AZURE_DEVOPS_EXT_PAT).toBeUndefined()
    expect(spec.env.GITHUB_TOKEN).toBeUndefined()
    expect(spec.env.ANTHROPIC_API_KEY).toBe('anthropic-key')
    expect(spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('claude-token')
    expect(spec.env.PATH).toBe('/usr/bin')
  })

  test('runs Claude with standard permission prompts and nothing that widens them', () => {
    const command = buildFixSpawnSpec(claudeBase(), 'Fix these.').initialCommand ?? ''

    expect(command).toContain('--permission-mode default')
    for (const flag of [
      'bypass',
      'dontAsk',
      'acceptEdits',
      '--dangerously',
      '--model',
      '--mcp-config',
      '--append-system-prompt'
    ]) {
      expect(command).not.toContain(flag)
    }
  })

  test('hands the prompt over after -- and only through the environment', () => {
    const prompt = "Fix O'Brien's $(comment)\n--print"
    const spec = buildFixSpawnSpec(claudeBase(), prompt)

    expect(spec.initialCommand).toMatch(/ -- "\$INTERSECT_FIX_PROMPT"$/)
    expect(spec.initialCommand).not.toContain("O'Brien")
    expect(spec.env[FIX_PROMPT_ENV]).toBe(prompt)
  })

  test('the prompt variable is not credential-shaped, so neither scrub layer removes it', () => {
    for (const token of SECRET_ENV_TOKENS) {
      expect(FIX_PROMPT_ENV).not.toMatch(new RegExp(`(^|_)${token}($|_)`, 'i'))
    }
    expect(FIX_PROMPT_ENV).not.toMatch(/^AZURE_DEVOPS_/i)
  })

  test('rejects NUL, which an environment value cannot carry', () => {
    expect(() => buildFixSpawnSpec(claudeBase(), 'bad\0byte')).toThrow(/NUL/)
  })

  test('keeps the attention-marker settings and the instance identity', () => {
    const spec = buildFixSpawnSpec(claudeBase(), 'Fix these.')

    expect(spec.initialCommand).toContain("--settings '/user data/notif.json'")
    expect(spec.env.INTERSECT_INSTANCE_ID).toBe('ws-1:tab-1')
  })

  test('without a prompt there is no trailing argument', () => {
    const spec = buildFixSpawnSpec(claudeBase(), null)

    expect(spec.initialCommand).toMatch(/--permission-mode default$/)
    expect(spec.env[FIX_PROMPT_ENV]).toBeUndefined()
  })

  test('a bash shell gets the bash scrub', () => {
    const spec = buildFixSpawnSpec(claudeBase({ shell: '/bin/bash' }), 'Fix these.')

    expect(spec.initialCommand).toMatch(/^for _iv in \$\(compgen -A export\); do /)
  })
})

describe('decorateTerminalSpec', () => {
  const never = (): string | null => null

  test('a resumed tab in a fix folder keeps --resume, gains the scrub and default permissions', () => {
    const base = claudeBase({ resume: 'sess-42' })
    const spec = decorateTerminalSpec(base, {
      preset: 'claude',
      cwd: FIX,
      isFixFolder,
      takePrompt: never
    })

    expect(spec.initialCommand).toContain("--resume 'sess-42'")
    expect(spec.initialCommand).toMatch(/^for _iv in /)
    expect(spec.initialCommand).toContain('--permission-mode default')
    expect(spec.initialCommand).not.toContain(FIX_PROMPT_ENV)
  })

  test('a shell tab in a fix folder and a Claude tab anywhere else are left as they are', () => {
    const shell = buildSpawn('shell', { shell: '/bin/zsh', env })
    expect(
      decorateTerminalSpec(shell, { preset: 'shell', cwd: FIX, isFixFolder, takePrompt: never })
    ).toBe(shell)

    const claude = claudeBase()
    expect(
      decorateTerminalSpec(claude, {
        preset: 'claude',
        cwd: '/repo',
        isFixFolder,
        takePrompt: () => 'not for this folder'
      })
    ).toBe(claude)
  })

  test('the first fresh spawn carries the parked prompt and the next one does not', () => {
    let parked: string | null = 'Fix these.'
    const takePrompt = (): string | null => {
      const prompt = parked
      parked = null
      return prompt
    }
    const opts = { preset: 'claude' as const, cwd: FIX, isFixFolder, takePrompt }

    const first = decorateTerminalSpec(claudeBase(), opts)
    const second = decorateTerminalSpec(claudeBase(), opts)

    expect(first.env[FIX_PROMPT_ENV]).toBe('Fix these.')
    expect(first.initialCommand).toMatch(/ -- "\$INTERSECT_FIX_PROMPT"$/)
    expect(second.env[FIX_PROMPT_ENV]).toBeUndefined()
    expect(second.initialCommand).toContain('--permission-mode default')
  })
})
