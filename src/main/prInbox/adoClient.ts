import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { resolveAdoServerConfig, type AdoServerConfig } from './adoConfig'

const CALL_TIMEOUT_MS = 30_000

interface Connection {
  client: Client
  transport: StdioClientTransport
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
  resolveConfig: () => AdoServerConfig = resolveAdoServerConfig
): AdoClient {
  let conn: Connection | null = null
  let connecting: Promise<Connection> | null = null

  async function connect(): Promise<Connection> {
    if (conn) return conn
    if (connecting) return connecting
    const config = resolveConfig()
    connecting = (async () => {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...process.env, ...config.env } as Record<string, string>,
        stderr: 'pipe'
      })
      const client = new Client({ name: 'intersect', version: '0.1.0' })
      await client.connect(transport)
      conn = { client, transport }
      return conn
    })()
    try {
      return await connecting
    } finally {
      connecting = null
    }
  }

  async function teardown(): Promise<void> {
    const current = conn
    conn = null
    if (!current) return
    try {
      await current.client.close()
    } catch {
      /* already gone */
    }
  }

  return {
    async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const { client } = await connect()
      let result: { isError?: boolean; content?: Array<{ type: string; text?: string }> }
      try {
        result = (await client.callTool({ name, arguments: args }, undefined, {
          timeout: CALL_TIMEOUT_MS
        })) as typeof result
      } catch (err) {
        // A timeout or transport error leaves the child in an unknown state; drop it so the next
        // call reconnects rather than reusing a wedged process.
        await teardown()
        throw new Error(`Azure DevOps call ${name} failed: ${err instanceof Error ? err.message : String(err)}`)
      }

      const text = (result.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')

      if (result.isError) {
        throw new Error(`Azure DevOps call ${name} returned an error: ${text || 'unknown error'}`)
      }
      if (!text) return undefined as unknown as T
      try {
        return JSON.parse(text) as T
      } catch {
        return text as unknown as T
      }
    },

    close: teardown
  }
}
