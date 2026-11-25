import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
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
