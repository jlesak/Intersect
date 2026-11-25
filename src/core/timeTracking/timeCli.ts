import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { TIME_CLI_DIR, TIME_CLI_SOCKET, TIME_CLI_TOKEN } from './timeCliServer'

const HELP = `Usage: intersect-time <command> [options]

  intersect-time list --day YYYY-MM-DD [--json]
  intersect-time add --actor claude|codex|user --day YYYY-MM-DD --duration 1h30m --description "Work" [--issue ABC-1]
  intersect-time edit --actor codex <ref> [--duration 45m] [--description "Work"] [--issue ABC-1 | --no-issue]
  intersect-time delete --actor user <ref>
  intersect-time group --actor codex <ref> <ref>... [--description "Together"] [--issue ABC-1]
  intersect-time ungroup --actor user <group-ref>

Use list --json to get refs for subsequent commands. The app must be running.
`

type Response = { code: number; value?: unknown; error?: string }
type Request = Record<string, unknown>

function parse(args: string[]): Request {
  const command = args.shift()
  if (!command || !['list', 'add', 'edit', 'delete', 'group', 'ungroup'].includes(command)) {
    throw new Error('Unknown command.')
  }
  const options: Record<string, string | boolean> = {}
  const refs: string[] = []
  const allowed = new Set(['--actor', '--day', '--duration', '--description', '--issue', '--no-issue', '--json'])
  while (args.length) {
    const arg = args.shift()!
    if (!arg.startsWith('--')) { refs.push(arg); continue }
    if (!allowed.has(arg) || arg in options) throw new Error('Invalid or duplicate option.')
    if (arg === '--json' || arg === '--no-issue') options[arg] = true
    else {
      const value = args.shift()
      if (!value || value.startsWith('--')) throw new Error('Missing option value.')
      options[arg] = value
    }
  }
  const keys: Record<string, string[]> = {
    list: ['--day', '--json'], add: ['--actor', '--day', '--duration', '--description', '--issue'],
    edit: ['--actor', '--duration', '--description', '--issue', '--no-issue'],
    delete: ['--actor'], group: ['--actor', '--description', '--issue'], ungroup: ['--actor']
  }
  if (Object.keys(options).some(key => !keys[command].includes(key)) ||
    (command === 'list' || command === 'add') && refs.length ||
    (command === 'edit' || command === 'delete' || command === 'ungroup') && refs.length !== 1 ||
    command === 'group' && refs.length < 2) throw new Error('Invalid command arguments.')
  return { command, actor: options['--actor'], day: options['--day'],
    duration: options['--duration'], description: options['--description'],
    issue: options['--issue'], noIssue: options['--no-issue'], json: options['--json'],
    ref: refs[0], refs }
}

function request(socketPath: string, token: string, body: Request): Promise<Response> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let reply = ''
    socket.setTimeout(2_100, () => socket.destroy(new Error('Time CLI request timed out.')))
    socket.on('data', chunk => { reply += chunk.toString('utf8') })
    socket.on('end', () => {
      try { resolve(JSON.parse(reply) as Response) }
      catch { reject(new Error('Invalid response from Intersect.')) }
    })
    socket.on('error', reject)
    socket.end(JSON.stringify({ token, request: body }))
  })
}

async function main(): Promise<number> {
  if (process.argv.length === 2 || process.argv.slice(2).includes('--help')) {
    process.stdout.write(HELP)
    return 0
  }
  let body: Request
  try { body = parse(process.argv.slice(2)) }
  catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 2
  }
  const dataDir = process.env.INTERSECT_TIME_DATA_DIR
  if (!dataDir) {
    process.stderr.write('Intersect is not running.\n')
    return 3
  }
  let token: string
  try { token = readFileSync(join(dataDir, TIME_CLI_DIR, TIME_CLI_TOKEN), 'utf8').trim() }
  catch {
    process.stderr.write('Intersect is not running.\n')
    return 3
  }
  let response: Response
  try { response = await request(join(dataDir, TIME_CLI_DIR, TIME_CLI_SOCKET), token, body) }
  catch {
    process.stderr.write('Intersect is not running.\n')
    return 3
  }
  if (response.code !== 0) {
    process.stderr.write(`${response.error ?? 'Time CLI request failed.'}\n`)
    return response.code
  }
  if (body.command === 'list') {
    if (body.json) process.stdout.write(`${JSON.stringify(response.value)}\n`)
    else for (const entry of response.value as Request[]) {
      process.stdout.write(`${entry.ref}  ${entry.durationMs}ms  ${entry.description}\n`)
    }
  } else process.stdout.write(`${(response.value as { ref: string }).ref}\n`)
  return 0
}

void main().then(code => { process.exitCode = code }, () => { process.exitCode = 1 })
