import { describe, expect, it } from 'vitest'
import { createLogger } from '@common/logging/logger'
import { fakeSink, readRecords } from '@common/logging/testSink'

/**
 * `createAdoClient` spawns a real stdio child, so these tests drive the logging decorator through
 * the exported helper instead of a live connection.
 */
import { createAdoClient, withMcpLogging } from './adoClient'

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
