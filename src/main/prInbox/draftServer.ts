/**
 * Intersect-owned MCP server, added to the interactive `claude` review session alongside the
 * user's own MCP servers. Its single tool, `record_draft_comment`, forwards the draft to the
 * Intersect main process over a Unix-domain socket. It has NO Azure DevOps access and no database
 * access - it cannot publish anything. Runs under plain `node` (no electron / no node:sqlite
 * import).
 */
import { createConnection, type Socket } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const sockPath = process.env.INTERSECT_DRAFT_SOCK
const sessionId = process.env.INTERSECT_REVIEW_SESSION ?? ''

if (!sockPath) {
  process.stderr.write('intersectReview: INTERSECT_DRAFT_SOCK is not set\n')
  process.exit(1)
}

let socket: Socket | null = null
function ensureSocket(): Socket {
  if (socket && !socket.destroyed) return socket
  socket = createConnection(sockPath as string)
  socket.on('error', (e) => process.stderr.write(`intersectReview: socket error ${e.message}\n`))
  return socket
}

function sendDraft(payload: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = ensureSocket()
    s.write(JSON.stringify({ sessionId, ...payload }) + '\n', (err) => (err ? reject(err) : resolve()))
  })
}

const server = new Server(
  { name: 'intersectReview', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'record_draft_comment',
      description:
        'Record a DRAFT pull-request review comment. Does not publish anything - the human reviews ' +
        'and approves drafts separately. Call once per comment, anchored to a file and a line on the ' +
        'RIGHT (new) side of the diff.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Repo-relative path of the file being commented on' },
          line: { type: 'number', description: '1-based line number on the right (new) side' },
          side: { type: 'string', enum: ['left', 'right'], description: 'Diff side; use right' },
          body: { type: 'string', description: 'The review comment text (markdown allowed)' }
        },
        required: ['filePath', 'line', 'body']
      }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'record_draft_comment') {
    throw new Error(`Unknown tool: ${req.params.name}`)
  }
  const a = (req.params.arguments ?? {}) as Record<string, unknown>
  await sendDraft({
    filePath: String(a.filePath ?? ''),
    line: Number(a.line),
    side: a.side === 'left' ? 'left' : 'right',
    body: String(a.body ?? '')
  })
  return {
    content: [{ type: 'text', text: `Draft recorded for ${String(a.filePath)}:${String(a.line)}` }]
  }
})

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport())
}

void main()
