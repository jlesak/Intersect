import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildNotifSettings, writeNotifSettings } from './notifSettings'

interface HookEntry {
  type: string
  command: string
}

interface HookGroup {
  matcher?: string
  hooks: HookEntry[]
}

interface NotifSettings {
  hooks: {
    Notification: HookGroup[]
    Stop: HookGroup[]
    UserPromptSubmit: HookGroup[]
    SessionStart: HookGroup[]
    SessionEnd: HookGroup[]
    PreToolUse: HookGroup[]
  }
}

const EXEC_PATH = '/Applications/Intersect.app/Contents/MacOS/Intersect'
const HELPER_PATH = '/Applications/Intersect.app/Contents/Resources/app/out/main/hookHelper.js'
const SUPPORT_DIR = '/Users/test/Library/Application Support/Intersect'

const build = (): NotifSettings =>
  buildNotifSettings(EXEC_PATH, HELPER_PATH, SUPPORT_DIR) as NotifSettings

const expectedCommand = (event: string): string =>
  `ELECTRON_RUN_AS_NODE=1 '${EXEC_PATH}' '${HELPER_PATH}' '${SUPPORT_DIR}' ${event}`

function commandFor(settings: NotifSettings, matcher: string): string {
  const group = settings.hooks.Notification.find((g) => g.matcher === matcher)
  if (!group) throw new Error(`no Notification hook for matcher ${matcher}`)
  return group.hooks[0].command
}

describe('buildNotifSettings', () => {
  it('defines Notification hooks for idle_prompt and permission_prompt', () => {
    const matchers = build().hooks.Notification.map((g) => g.matcher)
    expect(matchers).toEqual(['idle_prompt', 'permission_prompt'])
  })

  it('routes idle_prompt to the NotificationIdle event and permission_prompt to NotificationPermission', () => {
    const settings = build()
    expect(commandFor(settings, 'idle_prompt')).toBe(expectedCommand('NotificationIdle'))
    expect(commandFor(settings, 'permission_prompt')).toBe(
      expectedCommand('NotificationPermission')
    )
  })

  it('wires the turn-lifecycle hooks without a matcher (they fire unconditionally)', () => {
    const settings = build()
    for (const [key, event] of [
      ['Stop', 'Stop'],
      ['UserPromptSubmit', 'UserPromptSubmit'],
      ['SessionStart', 'SessionStart'],
      ['SessionEnd', 'SessionEnd']
    ] as const) {
      const groups = settings.hooks[key]
      expect(groups).toHaveLength(1)
      expect(groups[0]).not.toHaveProperty('matcher')
      expect(groups[0].hooks[0]).toEqual({ type: 'command', command: expectedCommand(event) })
    }
  })

  it('wires PreToolUse for every tool (no matcher) so the risk classifier sees each call', () => {
    const groups = build().hooks.PreToolUse
    expect(groups).toHaveLength(1)
    expect(groups[0]).not.toHaveProperty('matcher')
    expect(groups[0].hooks[0].command).toBe(expectedCommand('PreToolUse'))
  })

  it('single-quote escapes a support dir containing an apostrophe (no shell break)', () => {
    const dir = "/Users/O'Brien/Library/Application Support/Intersect"
    const settings = buildNotifSettings(EXEC_PATH, HELPER_PATH, dir) as NotifSettings
    expect(commandFor(settings, 'idle_prompt')).toBe(
      `ELECTRON_RUN_AS_NODE=1 '${EXEC_PATH}' '${HELPER_PATH}' '/Users/O'\\''Brien/Library/Application Support/Intersect' NotificationIdle`
    )
  })

  it('writeNotifSettings writes a file that round-trips to buildNotifSettings()', () => {
    const path = join(tmpdir(), `intersect-notif-settings-${process.pid}-${Date.now()}.json`)
    writeNotifSettings(path, EXEC_PATH, HELPER_PATH, SUPPORT_DIR)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written).toEqual(buildNotifSettings(EXEC_PATH, HELPER_PATH, SUPPORT_DIR))
  })

  it('omits statusLine entirely when no statusLineCommand is given', () => {
    expect(build()).not.toHaveProperty('statusLine')
  })

  it('wires statusLine.command when a statusLineCommand is given, leaving the hooks untouched', () => {
    const command = 'ELECTRON_RUN_AS_NODE=1 "/exec" "/script.js"'
    const settings = buildNotifSettings(EXEC_PATH, HELPER_PATH, SUPPORT_DIR, command) as NotifSettings & {
      statusLine: { type: string; command: string }
    }
    expect(settings.statusLine).toEqual({ type: 'command', command })
    expect(settings.hooks.Notification).toHaveLength(2)
    expect(settings.hooks.Stop).toHaveLength(1)
  })

  it('writeNotifSettings forwards statusLineCommand through to the written file', () => {
    const path = join(
      tmpdir(),
      `intersect-notif-settings-statusline-${process.pid}-${Date.now()}.json`
    )
    const command = 'ELECTRON_RUN_AS_NODE=1 "/exec" "/statusline.js"'
    writeNotifSettings(path, EXEC_PATH, HELPER_PATH, SUPPORT_DIR, command)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written).toEqual(buildNotifSettings(EXEC_PATH, HELPER_PATH, SUPPORT_DIR, command))
    expect(written.statusLine).toEqual({ type: 'command', command })
  })
})
