import { describe, expect, test, vi } from 'vitest'
import { Channel } from '@common/ipc'
import { createSystemHandlers, isAllowedExternalUrl, registerSystemHandlers } from './system.ipc'

describe('isAllowedExternalUrl', () => {
  test.each([
    ['https://jira.skoda.vwgroup.com/browse/FID2507-611', true],
    ['https://jira.skoda.vwgroup.com/', true],
    ['https://www.notion.so/greencode/1-1-Marek-abc123', true],
    ['https://notion.so/some-page', true],
    ['https://greencode.notion.so/some-page', true],
    ['https://greencode.slack.com/archives/D0000000', true],
    ['https://app.slack.com/client/T0/D0', true],
    ['http://jira.skoda.vwgroup.com/browse/FID2507-611', false],
    ['http://greencode.slack.com/archives/D0', false],
    ['https://evil-slack.com/x', false],
    ['https://evil.example.com/browse/FID2507-611', false],
    ['https://jira.skoda.vwgroup.com.evil.example.com/x', false],
    ['file:///etc/passwd', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
    ['', false]
  ])('%s -> %s', (url, allowed) => {
    expect(isAllowedExternalUrl(url)).toBe(allowed)
  })
})

describe('system handlers', () => {
  test('opens an allowlisted https URL through the injected launcher', async () => {
    const openExternal = vi.fn(async () => {})
    const h = createSystemHandlers({ openExternal, restartApp: vi.fn(), retryCore: vi.fn(), quitApp: vi.fn() })
    await h.openExternal('https://jira.skoda.vwgroup.com/browse/FID2507-611')
    expect(openExternal).toHaveBeenCalledWith('https://jira.skoda.vwgroup.com/browse/FID2507-611')
  })

  test('rejects a disallowed URL without ever calling the launcher', async () => {
    const openExternal = vi.fn(async () => {})
    const h = createSystemHandlers({ openExternal, restartApp: vi.fn(), retryCore: vi.fn(), quitApp: vi.fn() })
    await expect(h.openExternal('http://jira.skoda.vwgroup.com/x')).rejects.toThrow(/Blocked external URL/)
    await expect(h.openExternal('https://example.com')).rejects.toThrow(/Blocked external URL/)
    expect(openExternal).not.toHaveBeenCalled()
  })

  test('wraps a launcher failure as a message-only Error', async () => {
    const h = createSystemHandlers({
      openExternal: vi.fn(async () => {
        throw 'no browser'
      }),
      restartApp: vi.fn(),
      retryCore: vi.fn(),
      quitApp: vi.fn()
    })
    await expect(h.openExternal('https://jira.skoda.vwgroup.com/x')).rejects.toThrow(/no browser/)
  })
})

describe('registerSystemHandlers', () => {
  test('binds the system channels and forwards the url argument', async () => {
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
        registered.set(channel, listener)
      }
    }
    const openExternal = vi.fn(async () => {})
    const restartApp = vi.fn()
    const retryCore = vi.fn()
    const quitApp = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerSystemHandlers(ipcMain as any, createSystemHandlers({ openExternal, restartApp, retryCore, quitApp }))

    expect([...registered.keys()].sort()).toEqual(
      [
        Channel.systemOpenExternal,
        Channel.systemRestartApp,
        Channel.systemRetryCore,
        Channel.systemQuitApp
      ].sort()
    )
    await registered.get(Channel.systemOpenExternal)!({}, 'https://jira.skoda.vwgroup.com/browse/A-1')
    expect(openExternal).toHaveBeenCalledWith('https://jira.skoda.vwgroup.com/browse/A-1')
    await registered.get(Channel.systemRestartApp)!({})
    expect(restartApp).toHaveBeenCalledOnce()
    await registered.get(Channel.systemRetryCore)!({})
    expect(retryCore).toHaveBeenCalledOnce()
    await registered.get(Channel.systemQuitApp)!({})
    expect(quitApp).toHaveBeenCalledOnce()
  })
})
