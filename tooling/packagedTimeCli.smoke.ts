import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { installTimeCliShim } from '../src/core/timeTracking/timeCliInstall'

test('packaged CLI and installed shim run without node on PATH and use only a temp home', () => {
  const app = resolve(process.env.INTERSECT_PACKAGED_APP ?? 'dist/mac-arm64/Intersect.app')
  const binary = join(app, 'Contents/MacOS/Intersect')
  const script = join(app, 'Contents/Resources/app.asar/out/main/timeCli.js')
  expect(existsSync(binary)).toBe(true)
  const home = mkdtempSync(join(tmpdir(), 'intersect-time-package-'))
  try {
    const shim = join(home, '.local/bin/intersect-time')
    const profile = join(home, 'profile')
    expect(existsSync(shim)).toBe(false)
    expect(installTimeCliShim(home, binary, script, profile)).toBe(shim)
    const env = { ...process.env, HOME: home, PATH: '/usr/bin:/bin' }
    const help = spawnSync(shim, ['--help'], { env, encoding: 'utf8', timeout: 5_000 })
    expect(help.status, help.stderr).toBe(0)
    expect(help.stdout).toContain('intersect-time group')
    const offline = spawnSync(shim, ['list', '--day', '2026-11-25'],
      { env, encoding: 'utf8', timeout: 5_000 })
    expect(offline.status).toBe(3)
    expect(offline.stderr).toBe('Intersect is not running.\n')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
