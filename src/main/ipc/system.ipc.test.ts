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
    expect(isAllowedExternalUrl(url, '')).toBe(allowed)
  })
})

/**
 * The Azure DevOps server is per-user configuration, so it cannot be a fixed entry in the list. The
 * host the user actually pointed the app at is allowed and nothing else is, which keeps a link out
 * to a pull request working without turning the allowlist into a wildcard.
 */
describe('isAllowedExternalUrl - the configured Azure DevOps organisation', () => {
  const ORG_URL = 'https://devops.example.com/tfs/DefaultCollection'

  test('a pull request on the configured server is allowed', () => {
    expect(
      isAllowedExternalUrl(
        'https://devops.example.com/tfs/DefaultCollection/SPOT/_git/app/pullrequest/501',
        ORG_URL
      )
    ).toBe(true)
  })

  test('another Azure DevOps server is still blocked', () => {
    expect(isAllowedExternalUrl('https://dev.azure.com/acme/SPOT/_git/app/pullrequest/1', ORG_URL)).toBe(
      false
    )
    expect(
      isAllowedExternalUrl('https://devops.example.com.evil.example/x/_git/app/pullrequest/1', ORG_URL)
    ).toBe(false)
  })

  test('no configured organisation blocks every Azure DevOps address', () => {
    for (const org of ['', '   ', 'not a url']) {
      expect(
        isAllowedExternalUrl('https://devops.example.com/tfs/DefaultCollection/SPOT/_git/app/pullrequest/1', org)
      ).toBe(false)
    }
  })

  test('the configured organisation does not lower the bar for the fixed entries', () => {
    // Still https-only, and still no host outside the list.
    expect(isAllowedExternalUrl('http://devops.example.com/x', ORG_URL)).toBe(false)
    expect(isAllowedExternalUrl('https://evil.example.com/x', ORG_URL)).toBe(false)
    expect(isAllowedExternalUrl('https://jira.skoda.vwgroup.com/browse/A-1', ORG_URL)).toBe(true)
    expect(isAllowedExternalUrl('https://greencode.slack.com/archives/D0', ORG_URL)).toBe(true)
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
      quitApp: vi.fn(),
      userDataDir: '/profile',
      openPath: vi.fn(async () => ''),
      adoOrgUrl: async () => ''
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
      quitApp: vi.fn(),
      userDataDir: '/profile',
      openPath: vi.fn(async () => ''),
      adoOrgUrl: async () => ''
    })
    await expect(h.revealPath('/etc/passwd')).rejects.toThrow(/Blocked reveal path/)
    expect(revealInFolder).not.toHaveBeenCalled()
  })
})

/**
 * The escape a user takes when the app cannot start at all. It reveals one directory - the profile
 * main resolved for itself at startup - and takes no argument, so the renderer names no path and
 * there is no traversal surface to defend.
 */
describe('system handlers - reveal the user data directory', () => {
  const deps = (openPath: (path: string) => Promise<string>) => ({
    openExternal: vi.fn(async () => {}),
    revealInFolder: vi.fn(),
    restartApp: vi.fn(),
    retryCore: vi.fn(),
    quitApp: vi.fn(),
    userDataDir: '/Users/someone/Library/Application Support/Intersect',
    openPath: vi.fn(openPath),
    adoOrgUrl: async () => ''
  })

  test('opens the directory main resolved at startup', async () => {
    const d = deps(async () => '')
    await createSystemHandlers(d).revealUserData()
    expect(d.openPath).toHaveBeenCalledExactlyOnceWith(
      '/Users/someone/Library/Application Support/Intersect'
    )
  })

  test('a refusal from the shell surfaces as an Error rather than an empty success', async () => {
    // shell.openPath answers with a message instead of throwing, so a handler that ignored the
    // return value would report success while nothing opened.
    const d = deps(async () => 'The operation could not be completed')
    await expect(createSystemHandlers(d).revealUserData()).rejects.toThrow(
      /could not be completed/
    )
  })
})

describe('system handlers', () => {
  test('opens an allowlisted https URL through the injected launcher', async () => {
    const openExternal = vi.fn(async () => {})
    const h = createSystemHandlers({
      openExternal,
      revealInFolder: vi.fn(),
      restartApp: vi.fn(),
      retryCore: vi.fn(),
      quitApp: vi.fn(),
      userDataDir: '/profile',
      openPath: vi.fn(async () => ''),
      adoOrgUrl: async () => ''
    })
    await h.openExternal('https://jira.skoda.vwgroup.com/browse/FID2507-611')
    expect(openExternal).toHaveBeenCalledWith('https://jira.skoda.vwgroup.com/browse/FID2507-611')
  })

  test('rejects a disallowed URL without ever calling the launcher', async () => {
    const openExternal = vi.fn(async () => {})
    const h = createSystemHandlers({
      openExternal,
      revealInFolder: vi.fn(),
      restartApp: vi.fn(),
      retryCore: vi.fn(),
      quitApp: vi.fn(),
      userDataDir: '/profile',
      openPath: vi.fn(async () => ''),
      adoOrgUrl: async () => ''
    })
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
      quitApp: vi.fn(),
      userDataDir: '/profile',
      openPath: vi.fn(async () => ''),
      adoOrgUrl: async () => ''
    })
    await expect(h.openExternal('https://jira.skoda.vwgroup.com/x')).rejects.toThrow(/no browser/)
  })
})

/**
 * The organisation is read per call rather than captured once, so saving a different server in
 * Settings takes effect immediately and a link to the server the user just left stops working.
 */
describe('system handlers - the Azure DevOps organisation is resolved per call', () => {
  const PR_URL = 'https://devops.example.com/tfs/DefaultCollection/SPOT/_git/app/pullrequest/501'

  const handlers = (
    adoOrgUrl: () => Promise<string>,
    openExternal = vi.fn(async () => {})
  ): { h: ReturnType<typeof createSystemHandlers>; openExternal: typeof openExternal } => ({
    h: createSystemHandlers({
      openExternal,
      revealInFolder: vi.fn(),
      restartApp: vi.fn(),
      retryCore: vi.fn(),
      quitApp: vi.fn(),
      userDataDir: '/profile',
      openPath: vi.fn(async () => ''),
      adoOrgUrl
    }),
    openExternal
  })

  test('a pull request on the configured server reaches the browser', async () => {
    const { h, openExternal } = handlers(async () => 'https://devops.example.com/tfs/DefaultCollection')
    await h.openExternal(PR_URL)
    expect(openExternal).toHaveBeenCalledWith(PR_URL)
  })

  test('the same pull request is blocked once the app points elsewhere', async () => {
    let org = 'https://devops.example.com/tfs/DefaultCollection'
    const { h, openExternal } = handlers(async () => org)
    await h.openExternal(PR_URL)
    org = 'https://dev.azure.com/acme'
    await expect(h.openExternal(PR_URL)).rejects.toThrow(/Blocked external URL/)
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  test('an unconfigured organisation blocks the link without touching the browser', async () => {
    const { h, openExternal } = handlers(async () => '')
    await expect(h.openExternal(PR_URL)).rejects.toThrow(/Blocked external URL/)
    expect(openExternal).not.toHaveBeenCalled()
  })

  test('an organisation that cannot be read fails closed, and leaves the fixed hosts alone', async () => {
    const { h, openExternal } = handlers(async () => {
      throw new Error('core is down')
    })
    await expect(h.openExternal(PR_URL)).rejects.toThrow(/Blocked external URL/)
    await h.openExternal('https://jira.skoda.vwgroup.com/browse/A-1')
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://jira.skoda.vwgroup.com/browse/A-1')
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
      createSystemHandlers({
        openExternal,
        revealInFolder: vi.fn(),
        restartApp,
        retryCore,
        quitApp,
        userDataDir: '/profile',
        openPath: vi.fn(async () => ''),
        adoOrgUrl: async () => ''
      })
    )

    expect([...registered.keys()].sort()).toEqual(
      [
        Channel.systemOpenExternal,
        Channel.systemRevealPath,
        Channel.systemRestartApp,
        Channel.systemRetryCore,
        Channel.systemQuitApp,
        Channel.systemRevealUserData
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
