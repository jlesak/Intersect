import { existsSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { describe, expect, test, vi } from 'vitest'
import { mcpServerLaunch } from '../src/core/standaloneServerLaunch'

// Starts each standalone MCP server from the PACKAGED app exactly as the generated MCP config
// does, with no `node` on PATH, then runs the MCP handshake. Run `npm run pack:mac` first. Set
// INTERSECT_PACKAGED_APP to test another build, for example the installed one.
const appDir = resolve(process.env.INTERSECT_PACKAGED_APP ?? 'dist/mac-arm64/Intersect.app')
const execPath = join(appDir, 'Contents/MacOS/Intersect')
const mainDir = join(appDir, 'Contents/Resources/app.asar/out/main')

const servers = [
  { file: 'draftServer.js', tool: 'record_draft_comment', prefix: 'INTERSECT_DRAFT', session: 'REVIEW' },
  { file: 'jiraReportServer.js', tool: undefined, prefix: 'INTERSECT_JIRA', session: 'JIRA' },
  { file: 'otoReportServer.js', tool: undefined, prefix: 'INTERSECT_OTO', session: 'OTO' },
  { file: 'meetingsReportServer.js', tool: 'report_meetings', prefix: 'INTERSECT_MEETINGS', session: 'MEETINGS' }
]

describe('packaged MCP servers', () => {
  test('the packaged app exists', () => {
    expect(existsSync(execPath), `no packaged app at ${appDir}; run npm run pack:mac`).toBe(true)
  })

  test('a record_draft_comment call reaches the socket as one JSON line with the session id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'intersect-sock-'))
    const sock = join(dir, 'd.sock')
    const lines: string[] = []
    const listener = createServer((conn) => {
      let buf = ''
      conn.on('data', (d) => {
        buf += String(d)
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          lines.push(buf.slice(0, i))
          buf = buf.slice(i + 1)
        }
      })
    })
    await new Promise<void>((ok) => listener.listen(sock, ok))
    const launch = mcpServerLaunch(execPath, join(mainDir, 'draftServer.js'), {
      INTERSECT_DRAFT_SOCK: sock,
      INTERSECT_REVIEW_SESSION: 'smoke-session'
    })
    const client = new Client({ name: 'smoke', version: '0' })
    try {
      await client.connect(new StdioClientTransport({ ...launch, env: { ...launch.env, PATH: dir } }))
      await client.callTool({
        name: 'record_draft_comment',
        arguments: { filePath: 'a.ts', line: 3, side: 'right', body: 'hello' }
      })
      await vi.waitFor(() => expect(lines).toHaveLength(1))
      expect(JSON.parse(lines[0])).toEqual({
        sessionId: 'smoke-session',
        filePath: 'a.ts',
        line: 3,
        side: 'right',
        body: 'hello'
      })
    } finally {
      await client.close().catch(() => {})
      listener.close()
    }
  })

  test('the packaged meeting report forwards a synthetic day through the real MCP tool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'intersect-meetings-sock-'))
    const sock = join(dir, 'meetings.sock')
    const lines: string[] = []
    const listener = createServer((conn) => {
      let buffer = ''
      conn.on('data', (chunk) => {
        buffer += String(chunk)
        for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
          lines.push(buffer.slice(0, i))
          buffer = buffer.slice(i + 1)
        }
      })
    })
    await new Promise<void>((resolve) => listener.listen(sock, resolve))
    const launch = mcpServerLaunch(execPath, join(mainDir, 'meetingsReportServer.js'), {
      INTERSECT_MEETINGS_SOCK: sock, INTERSECT_MEETINGS_SESSION: 'synthetic-session'
    })
    const client = new Client({ name: 'smoke', version: '0' })
    try {
      await client.connect(new StdioClientTransport({ ...launch, env: { ...launch.env, PATH: dir } }))
      await client.callTool({ name: 'report_meetings', arguments: {
        day: '2026-11-25', events: [{ id: 'synthetic', subject: 'Test meeting',
          start: '2026-11-25T09:00:00+01:00', end: '2026-11-25T09:30:00+01:00' }]
      } })
      await vi.waitFor(() => expect(lines).toHaveLength(1))
      expect(JSON.parse(lines[0])).toMatchObject({ sessionId: 'synthetic-session',
        day: '2026-11-25', events: [{ id: 'synthetic', subject: 'Test meeting' }] })
    } finally {
      await client.close().catch(() => {})
      listener.close()
    }
  })

  test.each(servers)('$file starts and lists its tools', async ({ file, tool, prefix, session }) => {
    const emptyPath = mkdtempSync(join(tmpdir(), 'intersect-nopath-'))
    const launch = mcpServerLaunch(execPath, join(mainDir, file), {
      [`${prefix}_SOCK`]: join(emptyPath, 'none.sock'),
      [`INTERSECT_${session}_SESSION`]: 'smoke'
    })
    const transport = new StdioClientTransport({
      ...launch,
      env: { ...launch.env, PATH: emptyPath },
      stderr: 'pipe'
    })
    let stderr = ''
    transport.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const client = new Client({ name: 'smoke', version: '0' })
    try {
      await client.connect(transport)
      const tools = (await client.listTools()).tools.map((t) => t.name)
      expect(tools.length).toBeGreaterThan(0)
      if (tool) expect(tools).toContain(tool)
    } catch (err) {
      throw new Error(`${file} failed: ${String(err)}\nstderr: ${stderr}`)
    } finally {
      await client.close().catch(() => {})
    }
  })
})
