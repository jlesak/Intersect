/**
 * Intersect-owned MCP server, spawned by the hidden `claude` Jira fetch session as its ONLY MCP
 * server. Its single tool, `report_jira_issues`, forwards the fetched board (or the failure) to
 * the Intersect main process over a Unix-domain socket. It holds no Jira credentials and cannot
 * reach Jira itself. Runs under plain `node` (no electron / no node:sqlite import).
 */
import { createConnection, type Socket } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const sockPath = process.env.INTERSECT_JIRA_SOCK
const sessionId = process.env.INTERSECT_JIRA_SESSION ?? ''

if (!sockPath) {
  process.stderr.write('intersectJira: INTERSECT_JIRA_SOCK is not set\n')
  process.exit(1)
}

let socket: Socket | null = null
function ensureSocket(): Socket {
  if (socket && !socket.destroyed) return socket
  socket = createConnection(sockPath as string)
  socket.on('error', (e) => process.stderr.write(`intersectJira: socket error ${e.message}\n`))
  return socket
}

function sendReport(payload: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = ensureSocket()
    s.write(JSON.stringify({ sessionId, ...payload }) + '\n', (err) => (err ? reject(err) : resolve()))
  })
}

const server = new Server(
  { name: 'intersectJira', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'report_jira_issues',
      description:
        'Report the fetched Jira issues (or the failure to fetch them) back to Intersect. Call ' +
        'exactly once per session, with either ok=true and the full issues array, or ok=false ' +
        'and an error kind plus message.',
      inputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: 'True when the fetch succeeded' },
          error: {
            type: 'string',
            enum: ['auth', 'other'],
            description: 'Failure kind when ok is false; auth = missing/expired Jira SSO session'
          },
          message: { type: 'string', description: 'Human-readable failure detail when ok is false' },
          issues: {
            type: 'array',
            description: 'Every fetched issue when ok is true',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'Issue key, e.g. FID2507-611' },
                summary: { type: 'string', description: 'Issue summary/title' },
                status: { type: 'string', description: 'Jira workflow status name' },
                priority: {
                  type: ['string', 'null'],
                  description: 'Jira priority name, or null when the issue has none'
                },
                updated: { type: 'string', description: 'Last activity as an ISO timestamp' },
                url: { type: 'string', description: 'Browse URL of the issue' }
              },
              required: ['key', 'summary', 'status', 'updated']
            }
          }
        },
        required: ['ok']
      }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'report_jira_issues') {
    throw new Error(`Unknown tool: ${req.params.name}`)
  }
  const a = (req.params.arguments ?? {}) as Record<string, unknown>
  await sendReport({
    ok: a.ok === true,
    error: a.error === 'auth' ? 'auth' : 'other',
    message: String(a.message ?? ''),
    issues: Array.isArray(a.issues) ? a.issues : []
  })
  return {
    content: [{ type: 'text', text: 'Report received. You are done - stop now.' }]
  }
})

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport())
}

void main()
