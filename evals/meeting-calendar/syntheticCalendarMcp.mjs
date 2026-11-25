import { appendFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'synthetic-m365', version: '0' }, { capabilities: { tools: {} } })
const record = (line) => appendFileSync(process.env.SYNTHETIC_CALENDAR_CALLS, line + '\n')
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'outlook_calendar_search', description: 'Search the owner calendar for events. Search snippets do not include Join URLs.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'read_resource', description: 'Read one calendar event by its resource URI to get onlineMeeting.joinUrl.',
    inputSchema: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'] } }
] }))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'outlook_calendar_search') {
    record('search')
    return { content: [{ type: 'text', text: JSON.stringify({ events: [{
      id: 'synthetic-event-1', subject: 'Synthetic planning',
      start: '2026-11-25T09:00:00+01:00', end: '2026-11-25T09:30:00+01:00',
      uri: 'm365://calendar/synthetic-event-1'
    }] }) }] }
  }
  if (request.params.name === 'read_resource' &&
    request.params.arguments?.uri === 'm365://calendar/synthetic-event-1') {
    record('read')
    return { content: [{ type: 'text', text: JSON.stringify({
      id: 'synthetic-event-1', subject: 'Synthetic planning',
      start: '2026-11-25T09:00:00+01:00', end: '2026-11-25T09:30:00+01:00',
      onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/synthetic-detail' }
    }) }] }
  }
  throw new Error('Synthetic resource not found')
})
await server.connect(new StdioServerTransport())
