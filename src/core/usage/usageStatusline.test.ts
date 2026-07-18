import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  USAGE_SNAPSHOT_FILENAME,
  buildUsageStatuslineScript,
  extractUserStatuslineCommand,
  resolveUserStatuslineCommand,
  usageStatuslineCommand,
  writeUsageStatuslineScript
} from './usageStatusline'

/** A fresh real directory per test, so the snapshot file each test writes never collides. */
function freshUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'intersect-usage-userdata-'))
}

/** Writes `script` into `dir` and runs it in a real Node subprocess, exactly as Claude Code would. */
function runScript(dir: string, script: string, stdin: string): string {
  const path = join(dir, 'run.js')
  writeFileSync(path, script)
  return execFileSync(process.execPath, [path], { input: stdin, encoding: 'utf8' })
}

describe('usageStatuslineCommand', () => {
  it('invokes the script as Node via ELECTRON_RUN_AS_NODE', () => {
    const command = usageStatuslineCommand('/Applications/Intersect.app/MacOS/Intersect', '/data/script.js')
    expect(command).toBe(
      "ELECTRON_RUN_AS_NODE=1 '/Applications/Intersect.app/MacOS/Intersect' '/data/script.js'"
    )
  })

  it('single-quote escapes a path containing an apostrophe (no shell break)', () => {
    const command = usageStatuslineCommand("/Users/O'Brien/Intersect", '/data/script.js')
    expect(command).toBe("ELECTRON_RUN_AS_NODE=1 '/Users/O'\\''Brien/Intersect' '/data/script.js'")
  })

  it('survives characters that break plain double quotes: quotes, $, backticks', () => {
    const command = usageStatuslineCommand('/exec', '/data/weird"$(`.js')
    expect(command).toBe(`ELECTRON_RUN_AS_NODE=1 '/exec' '/data/weird"$(\`.js'`)
  })
})

describe('extractUserStatuslineCommand', () => {
  it('picks statusLine.command out of valid settings JSON', () => {
    const json = JSON.stringify({ statusLine: { type: 'command', command: 'my-statusline.sh' } })
    expect(extractUserStatuslineCommand(json)).toBe('my-statusline.sh')
  })

  it('returns null when there is no statusLine key', () => {
    expect(extractUserStatuslineCommand(JSON.stringify({ hooks: {} }))).toBeNull()
  })

  it('returns null for malformed JSON rather than throwing', () => {
    expect(extractUserStatuslineCommand('not json {{{')).toBeNull()
  })

  it('returns null when command is not a non-empty string', () => {
    expect(extractUserStatuslineCommand(JSON.stringify({ statusLine: { command: '' } }))).toBeNull()
    expect(extractUserStatuslineCommand(JSON.stringify({ statusLine: { command: 5 } }))).toBeNull()
  })
})

describe('resolveUserStatuslineCommand', () => {
  const withGlobal = JSON.stringify({ statusLine: { command: 'global-statusline.sh' } })
  const withLocal = JSON.stringify({ statusLine: { command: 'local-statusline.sh' } })
  const withoutStatusline = JSON.stringify({ hooks: {} })

  it('falls back to settings.json when settings.local.json has no statusline', () => {
    expect(resolveUserStatuslineCommand(withGlobal, withoutStatusline)).toBe('global-statusline.sh')
  })

  it('falls back to settings.json when settings.local.json could not be read', () => {
    expect(resolveUserStatuslineCommand(withGlobal, null)).toBe('global-statusline.sh')
  })

  it('prefers settings.local.json when only it defines a statusline', () => {
    expect(resolveUserStatuslineCommand(null, withLocal)).toBe('local-statusline.sh')
    expect(resolveUserStatuslineCommand(withoutStatusline, withLocal)).toBe('local-statusline.sh')
  })

  it('prefers settings.local.json over settings.json when both define one (Claude Code precedence)', () => {
    expect(resolveUserStatuslineCommand(withGlobal, withLocal)).toBe('local-statusline.sh')
  })

  it('returns null when neither file could be read or defines a statusline', () => {
    expect(resolveUserStatuslineCommand(null, null)).toBeNull()
    expect(resolveUserStatuslineCommand(withoutStatusline, withoutStatusline)).toBeNull()
  })
})

describe('buildUsageStatuslineScript', () => {
  it('is dependency-free CommonJS (no import statements)', () => {
    const script = buildUsageStatuslineScript('/data/userData', null)
    expect(script).not.toMatch(/^\s*import /m)
  })

  it('writeUsageStatuslineScript writes the script content verbatim to disk', () => {
    const path = join(tmpdir(), `intersect-usage-statusline-${process.pid}-${Date.now()}.js`)
    writeUsageStatuslineScript(path, '/data/userData', null)
    expect(readFileSync(path, 'utf8')).toBe(buildUsageStatuslineScript('/data/userData', null))
  })
})

describe('generated script: snapshot capture', () => {
  it('atomically writes {rateLimits, capturedAt} extracted from stdin, leaving no temp file behind', () => {
    const userDataDir = freshUserDataDir()
    const script = buildUsageStatuslineScript(userDataDir, null)
    const stdin = JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 7, resets_at: 1774933200 },
        seven_day: { used_percentage: 53, resets_at: 1780544400 }
      }
    })
    const before = Date.now()
    runScript(userDataDir, script, stdin)
    const after = Date.now()

    const written = JSON.parse(readFileSync(join(userDataDir, USAGE_SNAPSHOT_FILENAME), 'utf8'))
    expect(written.rateLimits).toEqual({
      five_hour: { used_percentage: 7, resets_at: 1774933200 },
      seven_day: { used_percentage: 53, resets_at: 1780544400 }
    })
    expect(written.capturedAt).toBeGreaterThanOrEqual(before)
    expect(written.capturedAt).toBeLessThanOrEqual(after)

    // No leftover .tmp file: the atomic write always ends in a rename.
    const leftovers = readdirSync(userDataDir).filter((f) => f.includes('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('writes rateLimits: null and still records capturedAt when rate_limits is absent (non-subscription user)', () => {
    const userDataDir = freshUserDataDir()
    const script = buildUsageStatuslineScript(userDataDir, null)
    runScript(userDataDir, script, JSON.stringify({ hooks: [], cwd: '/tmp' }))
    const written = JSON.parse(readFileSync(join(userDataDir, USAGE_SNAPSHOT_FILENAME), 'utf8'))
    expect(written.rateLimits).toBeNull()
    expect(typeof written.capturedAt).toBe('number')
  })

  it('never crashes on malformed stdin and still writes a null-rateLimits snapshot', () => {
    const userDataDir = freshUserDataDir()
    const script = buildUsageStatuslineScript(userDataDir, null)
    expect(() => runScript(userDataDir, script, 'not json at all {{{')).not.toThrow()
    const written = JSON.parse(readFileSync(join(userDataDir, USAGE_SNAPSHOT_FILENAME), 'utf8'))
    expect(written.rateLimits).toBeNull()
  })

  it('tolerates completely empty stdin', () => {
    const userDataDir = freshUserDataDir()
    const script = buildUsageStatuslineScript(userDataDir, null)
    expect(() => runScript(userDataDir, script, '')).not.toThrow()
  })
})

describe('generated script: statusline forwarding', () => {
  it('forwards the same stdin to the original command and echoes its stdout', () => {
    const userDataDir = freshUserDataDir()
    const fwdPath = join(userDataDir, 'fwd.js')
    writeFileSync(fwdPath, "process.stdout.write('FWD:' + require('fs').readFileSync(0, 'utf8'))")
    const originalCommand = `"${process.execPath}" "${fwdPath}"`
    const script = buildUsageStatuslineScript(userDataDir, originalCommand)

    const stdin = JSON.stringify({ model: 'opus', rate_limits: null })
    const out = runScript(userDataDir, script, stdin)
    expect(out).toBe(`FWD:${stdin}`)
  })

  it('prints nothing when the user has no statusline command configured', () => {
    const userDataDir = freshUserDataDir()
    const out = runScript(userDataDir, buildUsageStatuslineScript(userDataDir, null), JSON.stringify({ rate_limits: null }))
    expect(out).toBe('')
  })

  it('prints nothing (but still never throws) when the forwarded command itself fails', () => {
    const userDataDir = freshUserDataDir()
    const originalCommand = `"${process.execPath}" -e "process.exit(1)"`
    const script = buildUsageStatuslineScript(userDataDir, originalCommand)
    let out = ''
    expect(() => {
      out = runScript(userDataDir, script, JSON.stringify({ rate_limits: null }))
    }).not.toThrow()
    expect(out).toBe('')
  })
})
