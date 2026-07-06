import { describe, expect, test } from 'vitest'
import { buildSpawn, resolveShell } from './shell'

const env = {
  SHELL: '/bin/zsh',
  PATH: '/usr/bin',
  ELECTRON_RUN_AS_NODE: '1',
  ELECTRON_NO_ATTACH_CONSOLE: '1'
}

describe('resolveShell', () => {
  test('uses $SHELL when set, else falls back to /bin/zsh', () => {
    expect(resolveShell({ SHELL: '/bin/bash' })).toBe('/bin/bash')
    expect(resolveShell({})).toBe('/bin/zsh')
  })
})

describe('buildSpawn', () => {
  test('shell preset spawns a login shell with no initial command', () => {
    const spec = buildSpawn('shell', { env })
    expect(spec.file).toBe('/bin/zsh')
    expect(spec.args).toEqual(['-l'])
    expect(spec.initialCommand).toBeNull()
  })

  test('claude preset carries claude as the initial command (typed into the shell)', () => {
    expect(buildSpawn('claude', { env }).initialCommand).toBe('claude')
  })

  test('claude preset appends the quoted --settings path when one is given', () => {
    const spec = buildSpawn('claude', { env, notifSettingsPath: '/App Support/Intersect/n.json' })
    expect(spec.initialCommand).toBe("claude --settings '/App Support/Intersect/n.json'")
  })

  test('a --settings path with an apostrophe is safely escaped (no shell break)', () => {
    const spec = buildSpawn('claude', { env, notifSettingsPath: "/Users/O'Brien/n.json" })
    expect(spec.initialCommand).toBe("claude --settings '/Users/O'\\''Brien/n.json'")
  })

  test('the notif settings path never leaks into the plain shell preset', () => {
    const spec = buildSpawn('shell', { env, notifSettingsPath: '/App Support/Intersect/n.json' })
    expect(spec.initialCommand).toBeNull()
  })

  test('test mode uses a no-rc shell so E2E output is deterministic', () => {
    const spec = buildSpawn('shell', { env, testMode: true })
    expect(spec.args).not.toContain('-l')
    expect(spec.args).toContain('-f')
  })

  test('env strips ELECTRON_* vars and sets a 256-color TERM', () => {
    const spec = buildSpawn('shell', { env })
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(spec.env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined()
    expect(spec.env.TERM).toBe('xterm-256color')
    expect(spec.env.PATH).toBe('/usr/bin')
  })

  test('an explicit shell override is honored', () => {
    expect(buildSpawn('shell', { env, shell: '/opt/homebrew/bin/fish' }).file).toBe(
      '/opt/homebrew/bin/fish'
    )
  })
})
