import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildNotifSettings, writeNotifSettings } from './notifSettings'

interface NotificationHookGroup {
  matcher: string
  hooks: { type: string; command: string }[]
}

interface NotifSettings {
  hooks: { Notification: NotificationHookGroup[] }
}

/** Pulls the single-quoted printf payload out of a `printf '%s' '<payload>'` command string. */
function extractPayload(command: string): string {
  const match = command.match(/^printf '%s' '(.*)'$/s)
  if (!match) throw new Error(`command does not match expected printf form: ${command}`)
  return match[1]
}

function commandFor(settings: NotifSettings, matcher: string): string {
  const group = settings.hooks.Notification.find((g) => g.matcher === matcher)
  if (!group) throw new Error(`no Notification hook for matcher ${matcher}`)
  return group.hooks[0].command
}

describe('buildNotifSettings', () => {
  it('defines Notification hooks for idle_prompt and permission_prompt', () => {
    const settings = buildNotifSettings() as NotifSettings
    const matchers = settings.hooks.Notification.map((g) => g.matcher)
    expect(matchers).toEqual(['idle_prompt', 'permission_prompt'])
  })

  it('idle command carries the idle marker in a printf OSC 9 payload', () => {
    const command = commandFor(buildNotifSettings() as NotifSettings, 'idle_prompt')
    expect(command.startsWith(`printf '%s'`)).toBe(true)
    expect(command).toContain('INTERSECT_IDLE')
    expect(command).toContain(']9;')
    expect(command).toContain('\\u001b')
    expect(command).toContain('\\u0007')
  })

  it('permission command carries the permission marker', () => {
    const command = commandFor(buildNotifSettings() as NotifSettings, 'permission_prompt')
    expect(command).toContain('INTERSECT_PERMISSION')
  })

  it('the printed payload is valid JSON carrying the raw OSC 9 escape sequence', () => {
    const command = commandFor(buildNotifSettings() as NotifSettings, 'idle_prompt')
    const payload = extractPayload(command)
    const parsed = JSON.parse(payload) as { terminalSequence: string }
    expect(parsed.terminalSequence).toBe('\x1b]9;INTERSECT_IDLE\x07')
  })

  it('writeNotifSettings writes a file that round-trips to buildNotifSettings()', () => {
    const path = join(tmpdir(), `intersect-notif-settings-${process.pid}-${Date.now()}.json`)
    writeNotifSettings(path)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written).toEqual(buildNotifSettings())
  })
})
