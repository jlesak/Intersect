import { describe, expect, it } from 'vitest'
import { launchEnv, STRIPPED_LAUNCH_VARS } from './e2eLaunchEnv'

describe('launchEnv', () => {
  it('keeps the inherited environment the app needs', () => {
    const env = launchEnv({}, { PATH: '/usr/bin', HOME: '/Users/someone' })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/Users/someone')
  })

  it('applies the E2E overrides on top of the inherited environment', () => {
    const env = launchEnv({ INTERSECT_E2E: '1' }, { PATH: '/usr/bin' })
    expect(env).toEqual({ PATH: '/usr/bin', INTERSECT_E2E: '1' })
  })

  it('lets an override win over the inherited value', () => {
    const env = launchEnv({ INTERSECT_E2E: '1' }, { INTERSECT_E2E: '0' })
    expect(env.INTERSECT_E2E).toBe('1')
  })

  it('strips ELECTRON_RUN_AS_NODE, which the VSCode extension host exports', () => {
    const env = launchEnv({}, { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' })
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('strips it even when an override tries to set it back', () => {
    const env = launchEnv({ ELECTRON_RUN_AS_NODE: '1' }, {})
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })

  it('drops undefined values, which Playwright will not accept', () => {
    const env = launchEnv({}, { PATH: '/usr/bin', UNSET_BY_SHELL: undefined })
    expect(env).not.toHaveProperty('UNSET_BY_SHELL')
  })

  it('does not mutate the environment it was handed', () => {
    const base = { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' }
    launchEnv({}, base)
    expect(base.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('names every stripped variable, so the list cannot silently empty out', () => {
    expect(STRIPPED_LAUNCH_VARS).toContain('ELECTRON_RUN_AS_NODE')
  })
})
