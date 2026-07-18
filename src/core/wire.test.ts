import { describe, expect, test } from 'vitest'
import {
  CORE_INVOKE_CHANNELS,
  CORE_NOTIFY_CHANNELS,
  ELECTRON_ONLY_CHANNELS,
  RENDERER_PUSH_CHANNELS,
  type WireRoutes
} from '@common/coreBridge'
import { Channel } from '@common/ipc'
import { assertRoutesCoverBridge, createDispatch, mergeRoutes } from './wire'

describe('bridge channel classification', () => {
  test('every renderer channel belongs to exactly one direction', () => {
    for (const channel of Object.values(Channel)) {
      const memberships = [
        ELECTRON_ONLY_CHANNELS.has(channel),
        CORE_NOTIFY_CHANNELS.has(channel),
        RENDERER_PUSH_CHANNELS.has(channel),
        CORE_INVOKE_CHANNELS.has(channel)
      ].filter(Boolean)
      expect(memberships, `channel ${channel}`).toHaveLength(1)
    }
  })

  test('the Electron-only allowlist is exactly the OS-integration surface', () => {
    expect([...ELECTRON_ONLY_CHANNELS].sort()).toEqual(
      [
        Channel.workspacesPickFolder,
        Channel.oneOnOnePickVtt,
        Channel.systemOpenExternal,
        Channel.systemRestartApp
      ].sort()
    )
  })
})

describe('mergeRoutes', () => {
  test('composes slice maps and rejects a channel served twice', () => {
    const a: WireRoutes = { 'x:one': () => 1 }
    const b: WireRoutes = { 'x:two': () => 2 }
    expect(Object.keys(mergeRoutes(a, b)).sort()).toEqual(['x:one', 'x:two'])
    expect(() => mergeRoutes(a, { 'x:one': () => 3 })).toThrow('wire route collision: x:one')
  })
})

describe('createDispatch', () => {
  test('applies the wire args to the routed handler', async () => {
    const dispatch = createDispatch({ 'x:add': (a: number, b: number) => a + b })
    await expect(dispatch('x:add', [2, 3])).resolves.toBe(5)
  })

  test('rejects an unknown channel instead of hanging the caller', async () => {
    const dispatch = createDispatch({})
    await expect(dispatch('nope:really', [])).rejects.toThrow(
      'no core handler for channel: nope:really'
    )
  })
})

describe('assertRoutesCoverBridge', () => {
  test('accepts routes serving exactly the forwarded channels', () => {
    const routes: WireRoutes = {}
    for (const channel of [...CORE_INVOKE_CHANNELS, ...CORE_NOTIFY_CHANNELS]) {
      routes[channel] = () => undefined
    }
    expect(() => assertRoutesCoverBridge(routes)).not.toThrow()
  })

  test('names missing and extra channels', () => {
    const routes: WireRoutes = {}
    for (const channel of [...CORE_INVOKE_CHANNELS, ...CORE_NOTIFY_CHANNELS]) {
      routes[channel] = () => undefined
    }
    delete routes[Channel.todoAdd]
    routes['rogue:channel'] = () => undefined
    expect(() => assertRoutesCoverBridge(routes)).toThrow(/missing: todo:add/)
    expect(() => assertRoutesCoverBridge(routes)).toThrow(/not bridge channels: rogue:channel/)
  })
})
