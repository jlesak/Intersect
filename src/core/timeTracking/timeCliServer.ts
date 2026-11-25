import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync,
  writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createConnection, createServer, type Socket } from 'node:net'
import { join } from 'node:path'

export const TIME_CLI_DIR = 'time-cli'
export const TIME_CLI_SOCKET = 'time.sock'
export const TIME_CLI_TOKEN = 'token'
const MAX_BYTES = 16 * 1024

type Dispatch = (input: unknown, alive?: () => boolean) => Promise<{
  code: number; value?: unknown; error?: string
}>

function staleSocket(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const client = createConnection(path)
    client.once('connect', () => { client.destroy(); resolve(false) })
    client.once('error', () => resolve(true))
  })
}

export async function startTimeCliServer(userDataDir: string, dispatch: Dispatch) {
  const dir = join(userDataDir, TIME_CLI_DIR)
  if (existsSync(dir)) {
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) {
      throw new Error('Time CLI directory is unsafe')
    }
  } else mkdirSync(dir, { mode: 0o700 })
  chmodSync(dir, 0o700)
  const socketPath = join(dir, TIME_CLI_SOCKET)
  const tokenPath = join(dir, TIME_CLI_TOKEN)
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket() || !await staleSocket(socketPath)) {
      throw new Error('Time CLI socket is already in use')
    }
    unlinkSync(socketPath)
  }
  const token = randomBytes(32).toString('hex')
  const temporary = join(dir, `token-${process.pid}-${randomBytes(6).toString('hex')}`)
  writeFileSync(temporary, `${token}\n`, { mode: 0o600, flag: 'wx' })
  renameSync(temporary, tokenPath)
  chmodSync(tokenPath, 0o600)
  const sockets = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket)
    let active = true
    const deadline = performance.now() + 2_000
    let done = false
    const chunks: Buffer[] = []
    let size = 0
    const reply = (value: unknown) => {
      if (done) return
      done = true
      socket.end(`${JSON.stringify(value)}\n`)
    }
    const timer = setTimeout(() => {
      active = false
      reply({ code: 1, error: 'Request timed out.' })
    }, 2_000)
    socket.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BYTES) {
        active = false
        reply({ code: 2, error: 'Request exceeds 16 KB.' })
      } else chunks.push(chunk)
    })
    socket.on('end', () => {
      if (!active) return
      let request: unknown
      try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { reply({ code: 2, error: 'Invalid JSON request.' }); return }
      if (!request || typeof request !== 'object' || Array.isArray(request) ||
        (request as { token?: unknown }).token !== token) {
        reply({ code: 4, error: 'Time CLI authentication failed.' })
        return
      }
      void dispatch((request as { request?: unknown }).request,
        () => active && performance.now() < deadline)
        .then(reply, () => reply({ code: 1, error: 'Time CLI request failed.' }))
    })
    socket.on('close', () => { active = false; clearTimeout(timer); sockets.delete(socket) })
    socket.on('error', () => {})
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { server.off('error', reject); resolve() })
    })
    chmodSync(socketPath, 0o600)
  } catch (error) {
    if (existsSync(tokenPath) && readFileSync(tokenPath, 'utf8').trim() === token) unlinkSync(tokenPath)
    throw error
  }
  return {
    socketPath, tokenPath,
    async stop() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      if (existsSync(tokenPath) && readFileSync(tokenPath, 'utf8').trim() === token) {
        unlinkSync(tokenPath)
        if (existsSync(socketPath)) unlinkSync(socketPath)
      }
    }
  }
}
