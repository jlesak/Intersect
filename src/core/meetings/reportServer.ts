/** Calendar report MCP: one structured report, forwarded to the owning core over a local socket. */
import { createConnection, type Socket } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const socketPath = process.env.INTERSECT_MEETINGS_SOCK
const sessionId = process.env.INTERSECT_MEETINGS_SESSION ?? ''
if (!socketPath) {
  process.stderr.write('intersectMeetings: report socket is not set\n')
  process.exit(1)
}

let socket: Socket | null = null
function connection(): Socket {
  if (socket && !socket.destroyed) return socket
  socket = createConnection(socketPath as string)
  socket.on('error', () => { socket = null })
  return socket
}

const server = new Server(
  { name: 'intersectMeetings', version: '0.1.0' },
  { capabilities: { tools: {} } }
)
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'report_meetings',
    description: 'Return the structured calendar events for the requested local day to Intersect once.',
    inputSchema: {
      type: 'object',
      properties: {
        day: { type: 'string' },
        events: { type: 'array', items: { type: 'object' } },
        error: { type: 'string' }
      },
      required: ['day', 'events']
    }
  }]
}))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'report_meetings') throw new Error('Unknown calendar report tool')
  const args = request.params.arguments ?? {}
  if (typeof args.day !== 'string' || !Array.isArray(args.events) || args.events.length > 500) {
    throw new Error('Invalid calendar report')
  }
  await new Promise<void>((resolve, reject) => {
    connection().write(JSON.stringify({ sessionId, day: args.day, events: args.events,
      error: typeof args.error === 'string' ? args.error : '' }) + '\n', (err) =>
      err ? reject(err) : resolve())
  })
  return { content: [{ type: 'text', text: 'Report received. Stop now.' }] }
})
void server.connect(new StdioServerTransport())
