import { spawn } from 'node:child_process'

export interface McpServerLaunch {
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * The MCP config entry that starts one of the standalone MCP servers (draft review, jira report,
 * 1:1 report) for a Claude session.
 *
 * The server runs under Intersect's own binary with `ELECTRON_RUN_AS_NODE=1`, not under the
 * system `node`. Electron's asar-aware fs reads the bundle and every module it requires straight
 * from `app.asar`, so nothing has to be unpacked, no `node` has to be on PATH, and the Node
 * version is the one the bundle was built for. The hook helper and the status line script already
 * start this way. It needs the RunAsNode fuse to stay enabled (the electron-builder default).
 *
 * `scriptPath` is the plain `out/main/<server>.js` path, inside `app.asar` when packaged.
 */
export function mcpServerLaunch(
  execPath: string,
  scriptPath: string,
  env: Record<string, string>
): McpServerLaunch {
  return { command: execPath, args: [scriptPath], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
}

export type McpProbeResult = { ok: true } | { ok: false; message: string }

/**
 * Starts the server the way Claude will and sends one MCP `initialize`. Resolves when the server
 * answers, or with the server's own stderr when it exits or stays silent. Run it before launching
 * Claude: a server that dies at startup otherwise shows up only as `CONNECTION_CLOSED` inside the
 * session, with no hint why.
 */
export function probeMcpServer(launch: McpServerLaunch, timeoutMs = 10_000): Promise<McpProbeResult> {
  return new Promise((resolve) => {
    let stderr = ''
    let stdout = ''
    let settled = false
    const child = spawn(launch.command, launch.args, {
      env: { ...process.env, ...launch.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const finish = (result: McpProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(result)
    }
    const fail = (reason: string): void => {
      const detail = stderr.trim().slice(-800)
      finish({ ok: false, message: detail ? `${reason}: ${detail}` : reason })
    }
    const timer = setTimeout(() => fail(`MCP server did not answer within ${timeoutMs} ms`), timeoutMs)
    child.stderr.on('data', (d) => (stderr += String(d)))
    child.stdout.on('data', (d) => {
      stdout += String(d)
      if (/"id":\s*1\b/.test(stdout) && stdout.includes('"result"')) finish({ ok: true })
    })
    child.stdin.on('error', () => {})
    child.on('error', (e) => fail(`MCP server could not start (${e.message})`))
    child.on('exit', (code) => fail(`MCP server exited with code ${String(code)}`))
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'intersect-probe', version: '0' }
        }
      }) + '\n'
    )
  })
}
