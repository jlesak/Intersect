import { describe, expect, test } from 'vitest'
import { createTerminalHandlers } from './terminal.ipc'
import { makeFakeSessions } from './handlerTestkit'

const noAttach = (): Promise<{ live: false }> => Promise.resolve({ live: false })

describe('terminal handlers', () => {
  test('spawn forwards to the session manager and returns its result', () => {
    const { sessions, calls } = makeFakeSessions()
    const h = createTerminalHandlers(sessions, noAttach)
    expect(h.spawn('w:t', 'shell', '/repo', 80, 24)).toEqual({ ok: true })
    expect(calls.spawn).toContain('w:t')
  })

  test('kill forwards to the session manager', () => {
    const { sessions, calls } = makeFakeSessions()
    createTerminalHandlers(sessions, noAttach).kill('w:t')
    expect(calls.kill).toContain('w:t')
  })

  test('attach forwards to the injected reattach protocol', async () => {
    const { sessions } = makeFakeSessions()
    const seen: string[] = []
    const h = createTerminalHandlers(sessions, (id) => {
      seen.push(id)
      return Promise.resolve({ live: true, data: 'SNAP', cols: 80, rows: 24, lastSeq: 3 })
    })
    await expect(h.attach('w:t')).resolves.toEqual({
      live: true,
      data: 'SNAP',
      cols: 80,
      rows: 24,
      lastSeq: 3
    })
    expect(seen).toEqual(['w:t'])
  })
})
