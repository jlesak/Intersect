import { describe, expect, test, vi } from 'vitest'
import { Channel } from '@common/ipc'
import { createSystemHandlers, isAllowedExternalUrl, registerSystemHandlers } from './system.ipc'

describe('isAllowedExternalUrl', () => {
  test.each([
    ['https://jira.skoda.vwgroup.com/browse/FID2507-611', true],
    ['https://jira.skoda.vwgroup.com/', true],
    ['http://jira.skoda.vwgroup.com/browse/FID2507-611', false],
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
    const h = createSystemHandlers({ openExternal })
    await h.openExternal('https://jira.skoda.vwgroup.com/browse/FID2507-611')
    expect(openExternal).toHaveBeenCalledWith('https://jira.skoda.vwgroup.com/browse/FID2507-611')
  })

  test('rejects a disallowed URL without ever calling the launcher', async () => {
    const openExternal = vi.fn(async () => {})
    const h = createSystemHandlers({ openExternal })
    await expect(h.openExternal('http://jira.skoda.vwgroup.com/x')).rejects.toThrow(/Blocked external URL/)
    await expect(h.openExternal('https://example.com')).rejects.toThrow(/Blocked external URL/)
    expect(openExternal).not.toHaveBeenCalled()
  })

  test('wraps a launcher failure as a message-only Error', async () => {
    const h = createSystemHandlers({
      openExternal: vi.fn(async () => {
        throw 'no browser'
      })
    })
    await expect(h.openExternal('https://jira.skoda.vwgroup.com/x')).rejects.toThrow(/no browser/)
  })
})

describe('registerSystemHandlers', () => {
  test('binds the openExternal channel and forwards the url argument', async () => {
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
        registered.set(channel, listener)
      }
    }
    const openExternal = vi.fn(async () => {})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerSystemHandlers(ipcMain as any, createSystemHandlers({ openExternal }))

    expect([...registered.keys()]).toEqual([Channel.systemOpenExternal])
    await registered.get(Channel.systemOpenExternal)!({}, 'https://jira.skoda.vwgroup.com/browse/A-1')
    expect(openExternal).toHaveBeenCalledWith('https://jira.skoda.vwgroup.com/browse/A-1')
  })
})
