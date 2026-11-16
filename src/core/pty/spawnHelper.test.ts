import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeSpawnHelperExecutable } from './spawnHelper'

const PREBUILD = join('prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')

/** Lays out node-pty under `modulesDir` with a spawn-helper that has lost its execute bit. */
function installNodePty(modulesDir: string): { entry: string; helper: string } {
  const pkg = join(modulesDir, 'node-pty')
  const helper = join(pkg, PREBUILD)
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  mkdirSync(join(helper, '..'), { recursive: true })
  writeFileSync(join(pkg, 'lib', 'index.js'), '')
  writeFileSync(helper, '')
  chmodSync(helper, 0o644)
  return { entry: join(pkg, 'lib', 'index.js'), helper }
}

const isExecutable = (path: string): boolean => (statSync(path).mode & 0o111) !== 0

describe('makeSpawnHelperExecutable', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'spawn-helper-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('restores the execute bit in a plain node_modules install', () => {
    const { entry, helper } = installNodePty(join(root, 'node_modules'))

    makeSpawnHelperExecutable(entry)

    expect(isExecutable(helper)).toBe(true)
  })

  // The installed app resolves node-pty inside app.asar, but node-pty runs the helper from
  // app.asar.unpacked, the only copy on disk. Fixing the archive path left every terminal failing
  // with "posix_spawnp failed".
  it('restores the execute bit in app.asar.unpacked when node-pty resolves inside app.asar', () => {
    const resources = join(root, 'Intersect.app', 'Contents', 'Resources')
    const { helper } = installNodePty(join(resources, 'app.asar.unpacked', 'node_modules'))
    const entry = join(resources, 'app.asar', 'node_modules', 'node-pty', 'lib', 'index.js')

    makeSpawnHelperExecutable(entry)

    expect(isExecutable(helper)).toBe(true)
  })

  it('does nothing when the helper is missing', () => {
    expect(() => makeSpawnHelperExecutable(join(root, 'node-pty', 'lib', 'index.js'))).not.toThrow()
  })
})
