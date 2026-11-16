import { describe, expect, test } from 'vitest'
import { mcpServerLaunch, probeMcpServer } from './standaloneServerLaunch'

const node = (script: string) => ({ command: process.execPath, args: ['-e', script], env: {} })

describe('mcpServerLaunch', () => {
  test('runs the script under the given binary as plain Node, keeping the caller env', () => {
    expect(mcpServerLaunch('/App/Intersect', '/App/app.asar/out/main/draftServer.js', { A: 'b' })).toEqual({
      command: '/App/Intersect',
      args: ['/App/app.asar/out/main/draftServer.js'],
      env: { A: 'b', ELECTRON_RUN_AS_NODE: '1' }
    })
  })
})

describe('probeMcpServer', () => {
  test('is ok when the server answers initialize', async () => {
    const answer = `process.stdin.once('data',()=>console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{}})))`
    expect(await probeMcpServer(node(answer))).toEqual({ ok: true })
  })

  test('reports the stderr of a server that dies at startup', async () => {
    const result = await probeMcpServer(node(`console.error("Cannot find module 'ajv'");process.exit(1)`))
    expect(result).toEqual({
      ok: false,
      message: expect.stringMatching(/exited with code 1: Cannot find module 'ajv'/)
    })
  })

  test('reports a binary that does not exist', async () => {
    const result = await probeMcpServer({ command: '/nonexistent/binary', args: [], env: {} })
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/could not start/) })
  })

  test('gives up on a server that stays silent', async () => {
    const result = await probeMcpServer(node('setTimeout(()=>{},60000)'), 300)
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/did not answer within 300 ms/) })
  })
})
