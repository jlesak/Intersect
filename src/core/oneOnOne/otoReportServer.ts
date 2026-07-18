/**
 * Intersect-owned MCP server, spawned by the hidden 1:1 workflow sessions alongside the user's
 * own MCP servers. Its two tools - `report_process_result` and `report_prep_result` - forward the
 * workflow outcome to the Intersect main process over a Unix-domain socket. It holds no
 * credentials and cannot reach Notion or Slack itself. Runs under plain `node` (no electron / no
 * node:sqlite import).
 */
import { createConnection, type Socket } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const sockPath = process.env.INTERSECT_OTO_SOCK
const sessionId = process.env.INTERSECT_OTO_SESSION ?? ''

if (!sockPath) {
  process.stderr.write('intersectOneOnOne: INTERSECT_OTO_SOCK is not set\n')
  process.exit(1)
}

let socket: Socket | null = null
function ensureSocket(): Socket {
  if (socket && !socket.destroyed) return socket
  socket = createConnection(sockPath as string)
  socket.on('error', (e) => process.stderr.write(`intersectOneOnOne: socket error ${e.message}\n`))
  return socket
}

function sendReport(tool: string, payload: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = ensureSocket()
    s.write(JSON.stringify({ sessionId, tool, ...payload }) + '\n', (err) =>
      err ? reject(err) : resolve()
    )
  })
}

const server = new Server(
  { name: 'intersectOneOnOne', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'report_process_result',
      description:
        'Report the outcome of processing a 1:1 recording back to Intersect. Call exactly once ' +
        'per session: either ok=true with the Notion page URL and the Slack draft outcome, or ' +
        'ok=false with a short error.',
      inputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: 'True when the workflow succeeded' },
          notionUrl: {
            type: 'string',
            description: 'URL of the Notion page the 1:1 note was saved to, when ok is true'
          },
          slackDraftCreated: {
            type: 'boolean',
            description: 'Whether the Slack summary draft was created, when ok is true'
          },
          slackChannelLink: {
            type: 'string',
            description: 'The channel link Slack returned for the created draft, if any'
          },
          error: { type: 'string', description: 'Short failure description when ok is false' },
          message: { type: 'string', description: 'Optional human-readable detail' }
        },
        required: ['ok']
      }
    },
    {
      name: 'report_prep_result',
      description:
        'Report the finished 1:1 preparation briefing back to Intersect. Call exactly once per ' +
        'session: either ok=true with the full briefing as markdown, or ok=false with a short error.',
      inputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: 'True when the briefing was produced' },
          markdown: {
            type: 'string',
            description: 'The complete briefing as markdown, when ok is true'
          },
          error: { type: 'string', description: 'Short failure description when ok is false' },
          message: { type: 'string', description: 'Optional human-readable detail' }
        },
        required: ['ok']
      }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = (req.params.arguments ?? {}) as Record<string, unknown>
  if (req.params.name === 'report_process_result') {
    await sendReport('report_process_result', {
      ok: a.ok === true,
      notionUrl: String(a.notionUrl ?? ''),
      slackDraftCreated: a.slackDraftCreated === true,
      slackChannelLink: String(a.slackChannelLink ?? ''),
      error: String(a.error ?? a.message ?? '')
    })
  } else if (req.params.name === 'report_prep_result') {
    await sendReport('report_prep_result', {
      ok: a.ok === true,
      markdown: String(a.markdown ?? ''),
      error: String(a.error ?? a.message ?? '')
    })
  } else {
    throw new Error(`Unknown tool: ${req.params.name}`)
  }
  return {
    content: [{ type: 'text', text: 'Report received. You are done - stop now.' }]
  }
})

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport())
}

void main()
