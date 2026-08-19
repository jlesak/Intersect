import { describe, expect, it } from 'vitest'
import { createLogger } from '@common/logging/logger'
import { fakeSink, readRecords } from '@common/logging/testSink'

/**
 * `createAdoClient` spawns a real stdio child, so these tests drive the logging decorator through
 * the exported helper instead of a live connection.
 */
import { createAdoClient, recordMcpChildLifecycle, withMcpLogging } from './adoClient'

describe('recordMcpChildLifecycle', () => {
  const transport = (): { pid: number | null; onclose?: () => void } => ({ pid: 5150 })
  const mcpLogger = (sink: ReturnType<typeof fakeSink>) =>
    createLogger({ sink, level: 'debug', proc: 'core' as const, scope: 'mcp' as const })

  it('names the child and its pid when the server starts', () => {
    const sink = fakeSink()
    recordMcpChildLifecycle({
      transport: transport(),
      command: 'npx',
      logger: mcpLogger(sink),
      isLive: () => true
    })
    expect(readRecords(sink)[0]).toMatchObject({
      level: 'info',
      scope: 'mcp',
      msg: 'mcp server spawned',
      data: { command: 'npx', pid: 5150 }
    })
  })

  /**
   * A child that is killed - OOM, a crashed `npx` launcher - otherwise leaves only the failure of
   * whichever call happened to be in flight, which reads the same as a network timeout.
   */
  it('reports a child that died on its own at warn', () => {
    const sink = fakeSink()
    const t = transport()
    recordMcpChildLifecycle({ transport: t, command: 'npx', logger: mcpLogger(sink), isLive: () => true })
    t.onclose?.()
    expect(readRecords(sink)[1]).toMatchObject({
      level: 'warn',
      msg: 'mcp server exited',
      data: { command: 'npx', pid: 5150 }
    })
  })

  it('reports a child the client itself dropped at info', () => {
    const sink = fakeSink()
    const t = transport()
    recordMcpChildLifecycle({
      transport: t,
      command: 'npx',
      logger: mcpLogger(sink),
      isLive: () => false
    })
    t.onclose?.()
    expect(readRecords(sink)[1]).toMatchObject({ level: 'info', msg: 'mcp server exited' })
  })

  it('keeps the close handler the MCP client installed', () => {
    const sink = fakeSink()
    const t = transport()
    let clientNotified = false
    t.onclose = () => void (clientNotified = true)
    recordMcpChildLifecycle({ transport: t, command: 'npx', logger: mcpLogger(sink), isLive: () => true })
    t.onclose?.()
    expect(clientNotified).toBe(true)
  })
})

describe('withMcpLogging', () => {
  it('logs a successful tool call at debug', async () => {
    const sink = fakeSink()
    const call = withMcpLogging(
      async () => ({ ok: true }),
      createLogger({ sink, level: 'debug', proc: 'core', scope: 'mcp' })
    )
    await call('repo_list_pull_requests', { project: 'p', top: 100 })
    expect(readRecords(sink)[0]).toMatchObject({
      level: 'debug',
      scope: 'mcp',
      msg: 'mcp tool call',
      data: { tool: 'repo_list_pull_requests' }
    })
  })

  it('logs a failing tool call at error and rethrows', async () => {
    const sink = fakeSink()
    const call = withMcpLogging(async () => {
      throw new Error('server died')
    }, createLogger({ sink, level: 'debug', proc: 'core', scope: 'mcp' }))
    await expect(call('repo_list_pull_requests', {})).rejects.toThrow('server died')
    expect(readRecords(sink)[0]).toMatchObject({ level: 'error', msg: 'mcp tool call failed' })
  })

  it('summarises arguments rather than logging their values', async () => {
    const sink = fakeSink()
    const call = withMcpLogging(
      async () => null,
      createLogger({ sink, level: 'debug', proc: 'core', scope: 'mcp' })
    )
    await call('pr_create_comment', { body: 'a private review remark' })
    expect(sink.lines.join()).not.toContain('a private review remark')
  })
})

describe('createAdoClient', () => {
  it('closes without reporting a teardown when no server was ever spawned', async () => {
    const sink = fakeSink()
    const client = createAdoClient(
      () => {
        throw new Error('Azure DevOps is not configured')
      },
      () => Promise.resolve(),
      createLogger({ sink, level: 'debug', proc: 'core', scope: 'mcp' })
    )
    await expect(client.close()).resolves.toBeUndefined()
    expect(sink.lines).toEqual([])
  })
})
