import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { Channel } from '@common/ipc'
import {
  createSystemHandlers,
  isAllowedExternalUrl,
  isRevealablePath,
  registerSystemHandlers
} from './system.ipc'

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

describe('isRevealablePath', () => {
  let dir: string
  let claudeFile: string
  let outsideFile: string
  let escapingSymlink: string
  let claudeDir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'intersect-reveal-'))
    claudeDir = join(dir, 'proj', '.claude')
    mkdirSync(claudeDir, { recursive: true })
    claudeFile = join(claudeDir, 'settings.json')
    writeFileSync(claudeFile, '{}')
    outsideFile = join(dir, 'outside.json')
    writeFileSync(outsideFile, '{}')
    // A symlink inside a .claude dir whose target escapes it must resolve outside and be blocked.
    escapingSymlink = join(claudeDir, 'escape.json')
    symlinkSync(outsideFile, escapingSymlink)
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('allows a regular file inside a .claude directory', () => {
    expect(isRevealablePath(claudeFile)).toBe(true)
  })

  test('blocks a file outside any .claude root', () => {
    expect(isRevealablePath(outsideFile)).toBe(false)
  })

  test('blocks a symlink inside .claude that resolves outside it', () => {
    expect(isRevealablePath(escapingSymlink)).toBe(false)
  })

  test('blocks a directory and a nonexistent path', () => {
    expect(isRevealablePath(claudeDir)).toBe(false)
    expect(isRevealablePath(join(dir, 'nope.json'))).toBe(false)
  })
})

describe('system handlers - reveal', () => {
  let dir: string
  let claudeFile: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'intersect-reveal-h-'))
    const claudeDir = join(dir, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    claudeFile = join(claudeDir, 'agent.md')
    writeFileSync(claudeFile, 'x')
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('reveals a validated .claude file through the injected shell hook', async () => {
    const revealInFolder = vi.fn()
    const h = createSystemHandlers({
      openExternal: vi.fn(async () => {}),
      revealInFolder,
      restartApp: vi.fn(),
      retryCore: vi.fn(),
      quitApp: vi.fn()
    })
    await h.revealPath(claudeFile)
    expect(revealInFolder).toHaveBeenCalledWith(claudeFile)
  })

  test('refuses a path outside any .claude root without touching the shell', async () => {
    const revealInFolder = vi.fn()
    const h = createSystemHandlers({
      openExternal: vi.fn(async () => {}),
      revealInFolder,
      restartApp: vi.fn(),
      retryCore: vi.fn(),
      quitApp: vi.fn()
    })
    await expect(h.revealPath('/etc/passwd')).rejects.toThrow(/Blocked reveal path/)
    expect(revealInFolder).not.toHaveBeenCalled()
  })
})

describe('system handlers', () => {
  test('opens an allowlisted https URL through the injected launcher', async () => {
    const openExternal = vi.fn(async () => {})
    const h = createSystemHandlers({ openExternal, revealInFolder: vi.fn(), restartApp: vi.fn(), retryCore: vi.fn(), quitApp: vi.fn() })
    await h.openExternal('https://jira.skoda.vwgroup.com/browse/FID2507-611')
    expect(openExternal).toHaveBeenCalledWith('https://jira.skoda.vwgroup.com/browse/FID2507-611')
  })

  test('rejects a disallowed URL without ever calling the launcher', async () => {
    const openExternal = vi.fn(async () => {})
    const h = createSystemHandlers({ openExternal, revealInFolder: vi.fn(), restartApp: vi.fn(), retryCore: vi.fn(), quitApp: vi.fn() })
    await expect(h.openExternal('http://jira.skoda.vwgroup.com/x')).rejects.toThrow(/Blocked external URL/)
    await expect(h.openExternal('https://example.com')).rejects.toThrow(/Blocked external URL/)
    expect(openExternal).not.toHaveBeenCalled()
  })

  test('wraps a launcher failure as a message-only Error', async () => {
    const h = createSystemHandlers({
      openExternal: vi.fn(async () => {
        throw 'no browser'
      }),
      revealInFolder: vi.fn(),
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
    registerSystemHandlers(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ipcMain as any,
      createSystemHandlers({ openExternal, revealInFolder: vi.fn(), restartApp, retryCore, quitApp })
    )

    expect([...registered.keys()].sort()).toEqual(
      [
        Channel.systemOpenExternal,
        Channel.systemRevealPath,
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
