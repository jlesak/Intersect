import { describe, expect, test } from 'vitest'
import { createTerminalHandlers } from './terminal.ipc'
import { makeFakeSessions } from './handlerTestkit'

describe('terminal handlers', () => {
  test('spawn forwards to the session manager and returns its result', () => {
    const { sessions, calls } = makeFakeSessions()
    const h = createTerminalHandlers(sessions)
    expect(h.spawn('w:t', 'shell', '/repo', 80, 24)).toEqual({ ok: true })
    expect(calls.spawn).toContain('w:t')
  })

  test('kill forwards to the session manager', () => {
    const { sessions, calls } = makeFakeSessions()
    createTerminalHandlers(sessions).kill('w:t')
    expect(calls.kill).toContain('w:t')
  })
})
