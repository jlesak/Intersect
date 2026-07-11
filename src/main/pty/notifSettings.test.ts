import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildHookScript, buildNotifSettings, writeNotifHookScript, writeNotifSettings } from './notifSettings'

interface HookEntry {
  type: string
  command: string
}

interface NotifSettings {
  hooks: {
    Notification: { matcher: string; hooks: HookEntry[] }[]
    Stop: { hooks: HookEntry[] }[]
  }
}

const EXEC_PATH = '/Applications/Intersect.app/Contents/MacOS/Intersect'
const SCRIPT_PATH = '/Users/test/Library/Application Support/Intersect/intersect-claude-notif-hook.js'

function commandFor(settings: NotifSettings, matcher: string): string {
  const group = settings.hooks.Notification.find((g) => g.matcher === matcher)
  if (!group) throw new Error(`no Notification hook for matcher ${matcher}`)
  return group.hooks[0].command
}

describe('buildNotifSettings', () => {
  it('defines Notification hooks for idle_prompt and permission_prompt', () => {
    const settings = buildNotifSettings(EXEC_PATH, SCRIPT_PATH) as NotifSettings
    const matchers = settings.hooks.Notification.map((g) => g.matcher)
    expect(matchers).toEqual(['idle_prompt', 'permission_prompt'])
  })

  it('defines a Stop hook with no matcher (Stop fires on every turn, unconditionally)', () => {
    const settings = buildNotifSettings(EXEC_PATH, SCRIPT_PATH) as NotifSettings
    expect(settings.hooks.Stop).toHaveLength(1)
    expect(settings.hooks.Stop[0]).not.toHaveProperty('matcher')
    expect(settings.hooks.Stop[0].hooks[0].type).toBe('command')
  })

  it('idle command invokes the hook script as Node with the idle kind', () => {
    const command = commandFor(buildNotifSettings(EXEC_PATH, SCRIPT_PATH) as NotifSettings, 'idle_prompt')
    expect(command).toBe(`ELECTRON_RUN_AS_NODE=1 '${EXEC_PATH}' '${SCRIPT_PATH}' idle`)
  })

  it('permission command invokes the hook script with the permission kind', () => {
    const command = commandFor(
      buildNotifSettings(EXEC_PATH, SCRIPT_PATH) as NotifSettings,
      'permission_prompt'
    )
    expect(command).toBe(`ELECTRON_RUN_AS_NODE=1 '${EXEC_PATH}' '${SCRIPT_PATH}' permission`)
  })

  it('the Stop command invokes the hook script with the stop kind', () => {
    const settings = buildNotifSettings(EXEC_PATH, SCRIPT_PATH) as NotifSettings
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(
      `ELECTRON_RUN_AS_NODE=1 '${EXEC_PATH}' '${SCRIPT_PATH}' stop`
    )
  })

  it('single-quote escapes a script path containing an apostrophe (no shell break)', () => {
    const scriptPath = "/Users/O'Brien/Library/Application Support/Intersect/intersect-claude-notif-hook.js"
    const command = commandFor(buildNotifSettings(EXEC_PATH, scriptPath) as NotifSettings, 'idle_prompt')
    expect(command).toBe(
      `ELECTRON_RUN_AS_NODE=1 '${EXEC_PATH}' '/Users/O'\\''Brien/Library/Application Support/Intersect/intersect-claude-notif-hook.js' idle`
    )
  })

  it('writeNotifSettings writes a file that round-trips to buildNotifSettings()', () => {
    const path = join(tmpdir(), `intersect-notif-settings-${process.pid}-${Date.now()}.json`)
    writeNotifSettings(path, EXEC_PATH, SCRIPT_PATH)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written).toEqual(buildNotifSettings(EXEC_PATH, SCRIPT_PATH))
  })

  it('omits statusLine entirely when no statusLineCommand is given', () => {
    const settings = buildNotifSettings(EXEC_PATH, SCRIPT_PATH) as { statusLine?: unknown }
    expect(settings).not.toHaveProperty('statusLine')
  })

  it('wires statusLine.command when a statusLineCommand is given, leaving the hooks untouched', () => {
    const command = 'ELECTRON_RUN_AS_NODE=1 "/exec" "/script.js"'
    const settings = buildNotifSettings(EXEC_PATH, SCRIPT_PATH, command) as NotifSettings & {
      statusLine: { type: string; command: string }
    }
    expect(settings.statusLine).toEqual({ type: 'command', command })
    expect(settings.hooks.Notification).toHaveLength(2)
    expect(settings.hooks.Stop).toHaveLength(1)
  })

  it('writeNotifSettings forwards statusLineCommand through to the written file', () => {
    const path = join(tmpdir(), `intersect-notif-settings-statusline-${process.pid}-${Date.now()}.json`)
    const command = 'ELECTRON_RUN_AS_NODE=1 "/exec" "/statusline.js"'
    writeNotifSettings(path, EXEC_PATH, SCRIPT_PATH, command)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written).toEqual(buildNotifSettings(EXEC_PATH, SCRIPT_PATH, command))
    expect(written.statusLine).toEqual({ type: 'command', command })
  })
})

describe('buildHookScript', () => {
  it('is dependency-free CommonJS carrying the three app-private tokens', () => {
    const script = buildHookScript()
    expect(script).not.toMatch(/^\s*import /m)
    expect(script).toContain('INTERSECT_IDLE')
    expect(script).toContain('INTERSECT_PERMISSION')
    expect(script).toContain('INTERSECT_STOP')
  })

  it('emits a bare marker (no stdin) for an unrecognised or empty message', () => {
    const script = buildHookScript()
    const out = runScript(script, 'idle', '')
    expect(JSON.parse(out).terminalSequence).toBe('\x1b]9;INTERSECT_IDLE\x07')
  })

  it('emits the marker with the base64-encoded message when stdin carries one', () => {
    const script = buildHookScript()
    const stdin = JSON.stringify({ message: 'Claude needs your permission to use Bash' })
    const out = runScript(script, 'permission', stdin)
    const sequence = JSON.parse(out).terminalSequence as string
    const match = sequence.match(/^\x1b\]9;INTERSECT_PERMISSION;([A-Za-z0-9+/=]*)\x07$/)
    expect(match).not.toBeNull()
    expect(Buffer.from(match![1], 'base64').toString('utf8')).toBe(
      'Claude needs your permission to use Bash'
    )
  })

  it('never crashes and falls back to a bare marker on malformed stdin', () => {
    const script = buildHookScript()
    const out = runScript(script, 'stop', 'not json at all {{{')
    expect(JSON.parse(out).terminalSequence).toBe('\x1b]9;INTERSECT_STOP\x07')
  })

  it('prints nothing for an unrecognised kind rather than throwing', () => {
    const script = buildHookScript()
    const out = runScript(script, 'bogus', '')
    expect(out).toBe('')
  })

  it('writeNotifHookScript writes the script content verbatim to disk', () => {
    const path = join(tmpdir(), `intersect-notif-hook-${process.pid}-${Date.now()}.js`)
    writeNotifHookScript(path)
    expect(readFileSync(path, 'utf8')).toBe(buildHookScript())
  })
})

/** Runs the generated hook script in a real Node subprocess, exactly as Claude Code's hook would. */
function runScript(script: string, kind: string, stdin: string): string {
  const path = join(tmpdir(), `intersect-notif-hook-run-${process.pid}-${Date.now()}-${Math.random()}.js`)
  writeFileSync(path, script)
  return execFileSync(process.execPath, [path, kind], { input: stdin, encoding: 'utf8' })
}
