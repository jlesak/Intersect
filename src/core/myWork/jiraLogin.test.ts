import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { createJiraLogin, type LoginProcess } from './jiraLogin'

interface FakeProcess extends LoginProcess {
  exit(code: number | null): void
  fail(err: Error): void
  kill: () => void
}

function fakeProcess(): FakeProcess {
  const exitCbs: ((code: number | null) => void)[] = []
  const errorCbs: ((err: Error) => void)[] = []
  return {
    on(event: 'exit' | 'error', cb: never) {
      if (event === 'exit') exitCbs.push(cb)
      else errorCbs.push(cb)
    },
    exit: (code) => exitCbs.forEach((cb) => cb(code)),
    fail: (err) => errorCbs.forEach((cb) => cb(err)),
    kill: vi.fn()
  } as FakeProcess
}

/** A python + script pair that actually exists, so the pre-flight access check passes. */
async function existingPaths(): Promise<{ pythonPath: string; scriptPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'imw-login-test-'))
  const pythonPath = join(dir, 'python')
  const scriptPath = join(dir, 'jira_login.py')
  await writeFile(pythonPath, '')
  await writeFile(scriptPath, '')
  return { pythonPath, scriptPath }
}

describe('createJiraLogin', () => {
  test('resolves ok when the login script exits 0', async () => {
    const proc = fakeProcess()
    const spawn = vi.fn(() => proc)
    const login = createJiraLogin({ ...(await existingPaths()), spawn })

    const result = login.login()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    proc.exit(0)
    await expect(result).resolves.toEqual({ ok: true })
  })

  test('a non-zero exit resolves as a not-completed failure', async () => {
    const proc = fakeProcess()
    const spawn = vi.fn(() => proc)
    const login = createJiraLogin({ ...(await existingPaths()), spawn })

    const result = login.login()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    proc.exit(1)
    const r = await result
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/not completed/)
  })

  test('a missing skill resolves as a failure without spawning anything', async () => {
    const spawn = vi.fn(() => fakeProcess())
    const login = createJiraLogin({
      pythonPath: '/nonexistent/python',
      scriptPath: '/nonexistent/jira_login.py',
      spawn
    })
    const r = await login.login()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/not installed/)
    expect(spawn).not.toHaveBeenCalled()
  })

  test('the timeout kills a login that never finishes', async () => {
    const proc = fakeProcess()
    const spawn = vi.fn(() => proc)
    const login = createJiraLogin({ ...(await existingPaths()), spawn, timeoutMs: 30 })

    const r = await login.login()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/timed out/)
    expect(proc.kill).toHaveBeenCalled()
  })

  test('concurrent login calls share one process', async () => {
    const proc = fakeProcess()
    const spawn = vi.fn(() => proc)
    const login = createJiraLogin({ ...(await existingPaths()), spawn })

    const [a, b] = [login.login(), login.login()]
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    proc.exit(0)
    expect(await a).toEqual(await b)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  test('a spawn throw resolves as a failure instead of rejecting', async () => {
    const login = createJiraLogin({
      ...(await existingPaths()),
      spawn: () => {
        throw new Error('spawn EACCES')
      }
    })
    const r = await login.login()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/EACCES/)
  })

  test('dispose kills a live login process', async () => {
    const proc = fakeProcess()
    const spawn = vi.fn(() => proc)
    const login = createJiraLogin({ ...(await existingPaths()), spawn })

    void login.login()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    login.dispose()
    expect(proc.kill).toHaveBeenCalled()
  })
})
