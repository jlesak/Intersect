import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { buildSummarySpawnSpec, runTimeSummary } from './timeSummaryRunner'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

test('spawn spec has exact isolation flags, empty cwd and scrubbed env', () => {
  const spec = buildSummarySpawnSpec('/bin/claude', '/tmp/empty', {
    HOME: '/synthetic/home', PATH: '/bin', LANG: 'en_US.UTF-8',
    ANTHROPIC_API_KEY: 'secret', CLAUDE_CONFIG_DIR: '/private/config',
    AZURE_DEVOPS_PAT: 'secret', ELECTRON_RUN_AS_NODE: '1'
  })
  expect(spec.file).toBe('/bin/claude')
  expect(spec.cwd).toBe('/tmp/empty')
  expect(spec.args).toEqual([
    '-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence',
    '--output-format', 'json', '--system-prompt', expect.any(String),
    '--setting-sources', '', '--safe-mode', '--disable-slash-commands', '--no-chrome'
  ])
  expect(spec.env).toMatchObject({ HOME: '/synthetic/home', PATH: '/bin', LANG: 'en_US.UTF-8' })
  expect(Object.keys(spec.env).sort()).toEqual(['HOME', 'LANG', 'PATH'])
})

test('a hung child is killed at the timeout and its temporary cwd is removed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intersect-summary-runner-test-')); dirs.push(root)
  const script = join(root, 'claude')
  writeFileSync(script, '#!/bin/sh\nexec /bin/sleep 5\n'); chmodSync(script, 0o700)
  await expect(runTimeSummary('Synthetic', { claudePath: script, tempRoot: root,
    timeoutMs: 20, parentEnv: { HOME: root, PATH: '/bin' } })).rejects.toThrow('model-timeout')
  const { readdirSync } = await import('node:fs')
  expect(readdirSync(root)).toEqual(['claude'])
})

test('an abort after child startup kills it and removes its temporary cwd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intersect-summary-runner-test-')); dirs.push(root)
  const script = join(root, 'claude')
  const pidFile = join(root, 'child.pid')
  writeFileSync(script, `#!/bin/sh\nprintf '%s' "$$" > "${pidFile}"\nexec /bin/sleep 5\n`)
  chmodSync(script, 0o700)
  const controller = new AbortController()
  const pending = runTimeSummary('Synthetic', { claudePath: script, tempRoot: root,
    signal: controller.signal, timeoutMs: 10_000, parentEnv: { HOME: root, PATH: '/bin' } })
  await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true))
  const pid = Number(readFileSync(pidFile, 'utf8'))
  expect(pid).toBeGreaterThan(1)
  controller.abort()
  await expect(pending).rejects.toThrow('model-aborted')
  await vi.waitFor(() => {
    let alive = true
    try { process.kill(pid, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false
    }
    expect(alive).toBe(false)
  })
  const { readdirSync } = await import('node:fs')
  expect(readdirSync(root).sort()).toEqual(['child.pid', 'claude'])
})
