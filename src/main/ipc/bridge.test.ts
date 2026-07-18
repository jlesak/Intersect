import { describe, expect, test } from 'vitest'
import {
  CORE_INVOKE_CHANNELS,
  CORE_NOTIFY_CHANNELS,
  ELECTRON_ONLY_CHANNELS,
  NATIVE_DOCK_BADGE_PUSH,
  NATIVE_NOTIFICATION_PUSH,
  type NativeNotificationRequest
} from '@common/coreBridge'
import { Channel } from '@common/ipc'
import { registerCoreBridge, type CoreBridgeDeps } from './bridge'

type Listener = (event: unknown, ...args: unknown[]) => unknown

function makeHarness(overrides: Partial<CoreBridgeDeps> = {}): {
  handles: Map<string, Listener>
  ons: Map<string, Listener>
  requests: Array<{ channel: string; args: unknown[] }>
  notifies: Array<{ channel: string; args: unknown[] }>
  rendered: Array<{ channel: string; payload: unknown }>
  notifications: NativeNotificationRequest[]
  badges: number[]
  emitPush: (channel: string, payload: unknown) => void
} {
  const handles = new Map<string, Listener>()
  const ons = new Map<string, Listener>()
  const requests: Array<{ channel: string; args: unknown[] }> = []
  const notifies: Array<{ channel: string; args: unknown[] }> = []
  const rendered: Array<{ channel: string; payload: unknown }> = []
  const notifications: NativeNotificationRequest[] = []
  const badges: number[] = []
  let pushHandler: ((channel: string, payload: unknown) => void) | null = null

  registerCoreBridge({
    ipcMain: {
      handle: (channel: string, listener: Listener) => {
        handles.set(channel, listener)
      },
      on: ((channel: string, listener: Listener) => {
        ons.set(channel, listener)
      }) as never
    } as CoreBridgeDeps['ipcMain'],
    host: {
      request: async (channel, args) => {
        requests.push({ channel, args })
        return `answer:${channel}`
      },
      notify: (channel, args) => {
        notifies.push({ channel, args })
      },
      onPush: (handler) => {
        pushHandler = handler
        return () => {}
      }
    },
    electronOnly: {
      [Channel.workspacesPickFolder]: () => '/picked',
      [Channel.oneOnOnePickVtt]: () => '/picked.vtt',
      [Channel.systemOpenExternal]: (url: string) => `opened:${url}`,
      [Channel.systemRevealPath]: (path: string) => `revealed:${path}`,
      [Channel.systemRestartApp]: () => 'restarted',
      [Channel.systemRetryCore]: () => 'retried',
      [Channel.systemQuitApp]: () => 'quit'
    },
    sendToRenderer: (channel, payload) => rendered.push({ channel, payload }),
    showNotification: (request) => notifications.push(request),
    setDockBadge: (count) => badges.push(count),
    ...overrides
  })

  return {
    handles,
    ons,
    requests,
    notifies,
    rendered,
    notifications,
    badges,
    emitPush: (channel, payload) => pushHandler!(channel, payload)
  }
}

describe('registerCoreBridge registration', () => {
  test('registers every invoke and Electron-only channel exactly once, notify channels as on()', () => {
    const h = makeHarness()
    const expectedHandles = [...CORE_INVOKE_CHANNELS, ...ELECTRON_ONLY_CHANNELS].sort()
    expect([...h.handles.keys()].sort()).toEqual(expectedHandles)
    expect([...h.ons.keys()].sort()).toEqual([...CORE_NOTIFY_CHANNELS].sort())
  })

  test('refuses to start with an unimplemented Electron-only channel', () => {
    expect(() =>
      makeHarness({
        electronOnly: {
          [Channel.workspacesPickFolder]: () => '/picked'
          // the remaining Electron-only channels missing
        }
      })
    ).toThrow(/missing Electron-only handler for /)
  })
})

describe('registerCoreBridge routing', () => {
  test('forwards an invoke channel to the core with its args', async () => {
    const h = makeHarness()
    const result = await h.handles.get(Channel.todoAdd)!({}, 'text', null)
    expect(result).toBe(`answer:${Channel.todoAdd}`)
    expect(h.requests).toEqual([{ channel: Channel.todoAdd, args: ['text', null] }])
  })

  test('answers an Electron-only channel natively, never touching the core', async () => {
    const h = makeHarness()
    const result = await h.handles.get(Channel.workspacesPickFolder)!({})
    expect(result).toBe('/picked')
    expect(h.requests).toEqual([])
  })

  test('forwards fire-and-forget channels as notifications', () => {
    const h = makeHarness()
    h.ons.get(Channel.terminalInput)!({}, 's1', 'ls\r')
    h.ons.get(Channel.terminalPause)!({}, 's1')
    expect(h.notifies).toEqual([
      { channel: Channel.terminalInput, args: ['s1', 'ls\r'] },
      { channel: Channel.terminalPause, args: ['s1'] }
    ])
  })

  test('routes core pushes: renderer broadcasts forwarded, native commands executed', () => {
    const h = makeHarness()
    h.emitPush(Channel.terminalData, { sessionId: 's1', data: 'x' })
    h.emitPush(Channel.myWorkChanged, { sourceKey: 'global' })
    h.emitPush(NATIVE_DOCK_BADGE_PUSH, { count: 3 })
    const request: NativeNotificationRequest = {
      sessionId: 's1',
      title: 'Tab',
      body: 'Needs your permission',
      silent: false
    }
    h.emitPush(NATIVE_NOTIFICATION_PUSH, request)

    expect(h.rendered).toEqual([
      { channel: Channel.terminalData, payload: { sessionId: 's1', data: 'x' } },
      { channel: Channel.myWorkChanged, payload: { sourceKey: 'global' } }
    ])
    expect(h.badges).toEqual([3])
    expect(h.notifications).toEqual([request])
  })

  test('main-sourced renderer channels are never expected from the core', () => {
    const h = makeHarness()
    // terminalNotificationClicked originates in main itself; a core push claiming it is a
    // routing bug and must not be forwarded as if legitimate.
    h.emitPush(Channel.terminalNotificationClicked, { sessionId: 's1' })
    expect(h.rendered).toEqual([])
  })
})
