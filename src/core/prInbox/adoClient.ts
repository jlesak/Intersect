import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Logger } from '@common/logging/logger'
import { summarizeArgs } from '@common/logging/record'
import { resolveAdoServerConfig, type AdoServerConfig } from './adoConfig'
import { applyLoginShellPath } from '../loginShellPath'

const CALL_TIMEOUT_MS = 30_000

interface Connection {
  client: Client
  transport: StdioClientTransport
}

type ToolCall = (name: string, args: Record<string, unknown>) => Promise<unknown>

/**
 * Record every Azure DevOps tool call. ADO is reached over an MCP stdio child rather than HTTP, so
 * this is the only seam where its traffic is observable at all. Each argument is reduced to its
 * shape and length, because the values carry review comment bodies and repository identifiers.
 */
export function withMcpLogging(call: ToolCall, logger: Logger): ToolCall {
  return async (name, args) => {
    const startedAt = Date.now()
    const data = { tool: name, args: summarizeArgs(Object.values(args)) }
    try {
      const result = await call(name, args)
      logger.debug('mcp tool call', { data: { ...data, durationMs: Date.now() - startedAt } })
      return result
    } catch (err) {
      logger.error('mcp tool call failed', {
        data: { ...data, durationMs: Date.now() - startedAt },
        err
      })
      throw err
    }
  }
}

/** The part of the stdio transport the child's lifecycle records need. */
export interface McpChildLifecycleDeps {
  transport: { readonly pid: number | null; onclose?: () => void }
  command: string
  logger: Logger
  /** Whether this connection is still the live one, so an exit now was nobody's decision. */
  isLive: () => boolean
}

/**
 * Record the start and the end of the MCP server child.
 *
 * Without the exit half, a child that is killed - out of memory, a launcher that dies - leaves only
 * the failure of whichever call happened to be in flight, which reads exactly like a network
 * timeout. The transport reports the close rather than the exit status, so the record names the
 * child by command and pid; it also already carries the client's own close handler, which is
 * chained rather than replaced.
 */
export function recordMcpChildLifecycle(deps: McpChildLifecycleDeps): void {
  const data = { command: deps.command, pid: deps.transport.pid }
  deps.logger.info('mcp server spawned', { data })
  const inner = deps.transport.onclose
  deps.transport.onclose = () => {
    if (deps.isLive()) deps.logger.warn('mcp server exited', { data })
    else deps.logger.info('mcp server exited', { data })
    inner?.()
  }
}

/**
 * Long-lived MCP client to the Azure DevOps server. One persistent stdio child is spawned lazily
 * and reused for every call. A call that times out or errors tears the connection down so the next
 * call rebuilds a fresh child (a wedged-but-alive server would otherwise time out forever). Connect
 * is guarded by a single shared promise so overlapping calls never spawn two children.
 */
export interface AdoClient {
  callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>
  close(): Promise<void>
}

export function createAdoClient(
  resolveConfig: () => AdoServerConfig = resolveAdoServerConfig,
  ensureEnv: () => Promise<void> = applyLoginShellPath,
  logger?: Logger
): AdoClient {
  let conn: Connection | null = null
  let connecting: Promise<Connection> | null = null

  async function connect(): Promise<Connection> {
    if (conn) return conn
    if (connecting) return connecting
    const config = resolveConfig()
    connecting = (async () => {
      // Launched from Finder/Dock the app inherits only /usr/bin:/bin, so the server's `npx`
      // launcher needs the login-shell PATH folded in before the child is spawned.
      await ensureEnv()
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...process.env, ...config.env } as Record<string, string>,
        stderr: 'pipe'
      })
      const client = new Client({ name: 'intersect', version: '0.1.0' })
      await client.connect(transport)
      const connection: Connection = { client, transport }
      conn = connection
      if (logger) {
        // After connect: the client installs its own close handler while connecting, and this
        // chains onto whatever is there rather than displacing it.
        recordMcpChildLifecycle({
          transport,
          command: config.command,
          logger,
          // `teardown` clears `conn` before it closes anything, so this child still being the
          // current one means it went on its own.
          isLive: () => conn === connection
        })
      }
      return connection
    })()
    try {
      return await connecting
    } finally {
      connecting = null
    }
  }

  /**
   * Drop the live child. The reason is recorded because a connection that disappears explains the
   * reconnect and the latency of the call that follows it.
   */
  async function teardown(reason: string): Promise<void> {
    const current = conn
    conn = null
    if (!current) return
    logger?.warn('mcp server connection torn down', { data: { reason } })
    try {
      await current.client.close()
    } catch {
      /* already gone */
    }
  }

  const rawCallTool: ToolCall = async (name, args) => {
    const { client } = await connect()
    let result: { isError?: boolean; content?: Array<{ type: string; text?: string }> }
    try {
      result = (await client.callTool({ name, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS
      })) as typeof result
    } catch (err) {
      // A timeout or transport error leaves the child in an unknown state; drop it so the next
      // call reconnects rather than reusing a wedged process.
      await teardown('tool call failed')
      throw new Error(`Azure DevOps call ${name} failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    const text = (result.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')

    if (result.isError) {
      throw new Error(`Azure DevOps call ${name} returned an error: ${text || 'unknown error'}`)
    }
    if (!text) return undefined
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }

  const callTool = logger ? withMcpLogging(rawCallTool, logger) : rawCallTool

  return {
    callTool: <T>(name: string, args: Record<string, unknown>): Promise<T> =>
      callTool(name, args) as Promise<T>,

    close: () => teardown('client closed')
  }
}
