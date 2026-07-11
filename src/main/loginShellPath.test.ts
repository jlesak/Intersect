import { describe, expect, test, vi } from 'vitest'
import { extractShellPath, mergePath, resolveLoginShellPath } from './loginShellPath'

describe('extractShellPath', () => {
  test('pulls the PATH from between the delimiters, ignoring surrounding dotfile noise', () => {
    const out = 'welcome to your shell\n__INTERSECT_PATH__/opt/homebrew/bin:/usr/bin__INTERSECT_PATH__'
    expect(extractShellPath(out)).toBe('/opt/homebrew/bin:/usr/bin')
  })

  test('returns null when the delimiters are absent (shell produced no usable output)', () => {
    expect(extractShellPath('some unrelated banner text')).toBeNull()
    expect(extractShellPath('')).toBeNull()
  })
})

describe('mergePath', () => {
  test('prepends login-shell dirs, keeps existing ones, and de-duplicates', () => {
    const merged = mergePath('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin')
    expect(merged).toBe('/opt/homebrew/bin:/usr/bin:/bin')
  })

  test('leaves the current PATH untouched when the login PATH could not be resolved', () => {
    expect(mergePath('/usr/bin:/bin', null)).toBe('/usr/bin:/bin')
  })

  test('drops empty segments so a stray colon never yields an empty PATH entry', () => {
    expect(mergePath('/usr/bin::', '/opt/homebrew/bin:')).toBe('/opt/homebrew/bin:/usr/bin')
  })

  test('uses the login PATH alone when there is no current PATH', () => {
    expect(mergePath(undefined, '/opt/homebrew/bin:/usr/bin')).toBe('/opt/homebrew/bin:/usr/bin')
  })
})

describe('resolveLoginShellPath', () => {
  test('runs the login shell and returns its parsed PATH', async () => {
    const run = vi
      .fn<(shell: string, args: string[]) => Promise<string>>()
      .mockResolvedValue('__INTERSECT_PATH__/opt/homebrew/bin:/usr/bin__INTERSECT_PATH__')
    const path = await resolveLoginShellPath({ shell: '/bin/zsh', run })
    expect(path).toBe('/opt/homebrew/bin:/usr/bin')
    const [shell, args] = run.mock.calls[0]
    expect(shell).toBe('/bin/zsh')
    // A login + interactive shell so both ~/.zprofile and ~/.zshrc (where Homebrew's PATH usually
    // lives) are sourced, matching how the PTY resolves the same tools.
    expect(args[0]).toBe('-ilc')
    // The variable must be braced (${PATH}); a bare $PATH followed by the underscore-led delimiter
    // parses as one (unset) identifier and expands to empty.
    expect(args[1]).toContain('${PATH}')
    expect(args[1]).not.toMatch(/\$PATH[A-Za-z0-9_]/)
  })

  test('the built command, run through a real POSIX shell, yields that shell PATH', async () => {
    // Exercises the actual shell-command string (not just a mocked runner), so a quoting/expansion
    // bug in it is caught. Uses /bin/sh with -c since -ilc needs an interactive tty.
    const run: (shell: string, args: string[]) => Promise<string> = async (_shell, args) =>
      require('node:child_process').execFileSync('/bin/sh', ['-c', args[args.length - 1]], {
        encoding: 'utf8',
        env: { PATH: '/sentinel/bin:/usr/bin' }
      })
    expect(await resolveLoginShellPath({ shell: '/bin/sh', run })).toBe('/sentinel/bin:/usr/bin')
  })

  test('returns null (best-effort) when launching the shell throws', async () => {
    const run = vi.fn<(shell: string, args: string[]) => Promise<string>>().mockRejectedValue(
      new Error('shell blew up')
    )
    expect(await resolveLoginShellPath({ shell: '/bin/zsh', run })).toBeNull()
  })
})
