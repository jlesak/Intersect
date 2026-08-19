import { describe, expect, it } from 'vitest'
import { withHttpLogging } from './httpLogging'
import { createLogger, type LogFields, type Logger, type LogSink } from './logger'
import { fakeSink, readRecords } from './testSink'

function logger(sink: LogSink) {
  return createLogger({ sink, level: 'debug', proc: 'core', scope: 'http' })
}

describe('withHttpLogging', () => {
  it('logs a successful request at debug', async () => {
    const sink = fakeSink()
    const wrapped = withHttpLogging(async () => new Response('{}', { status: 200 }), logger(sink))
    await wrapped('https://jira.example.com/rest/api/2/search')
    expect(readRecords(sink)[0]).toMatchObject({
      level: 'debug',
      scope: 'http',
      msg: 'http request',
      data: { method: 'GET', status: 200, url: 'https://jira.example.com/rest/api/2/search' }
    })
  })

  it('logs a 4xx or 5xx response at error', async () => {
    const sink = fakeSink()
    const wrapped = withHttpLogging(async () => new Response('nope', { status: 503 }), logger(sink))
    await wrapped('https://h.example/a')
    expect(readRecords(sink)[0]).toMatchObject({ level: 'error', data: { status: 503 } })
  })

  it('logs a transport failure and rethrows it', async () => {
    const sink = fakeSink()
    const wrapped = withHttpLogging(async () => {
      throw new Error('ECONNREFUSED')
    }, logger(sink))
    await expect(wrapped('https://h.example/a')).rejects.toThrow('ECONNREFUSED')
    expect(readRecords(sink)[0]).toMatchObject({ level: 'error', msg: 'http request failed' })
  })

  it('reports the method from the request init', async () => {
    const sink = fakeSink()
    const wrapped = withHttpLogging(async () => new Response('{}'), logger(sink))
    await wrapped('https://h.example/a', { method: 'POST' })
    expect((readRecords(sink)[0].data as { method: string }).method).toBe('POST')
  })

  it('never puts a credential from the query string in the log', async () => {
    const sink = fakeSink()
    const wrapped = withHttpLogging(async () => new Response('{}'), logger(sink))
    await wrapped('https://h.example/a?access_token=supersecret')
    expect(sink.lines.join()).not.toContain('supersecret')
  })

  // Serialisation redacts every string it writes, so the sink assertion above stays green even
  // when the decorator hands over a raw URL. This one watches the hand-off itself, which is where
  // the decorator's own obligation lives: the pass at serialisation is a second line of defence,
  // and the first one belongs here.
  it('hands the logger a URL that is already redacted', async () => {
    const fields: LogFields[] = []
    const capturing: Logger = {
      error: (_msg, f) => void fields.push(f ?? {}),
      warn: (_msg, f) => void fields.push(f ?? {}),
      info: (_msg, f) => void fields.push(f ?? {}),
      debug: (_msg, f) => void fields.push(f ?? {}),
      child: () => capturing
    }
    const wrapped = withHttpLogging(async () => new Response('{}'), capturing)
    await wrapped('https://h.example/a?access_token=supersecret')
    expect((fields[0].data as { url: string }).url).not.toContain('supersecret')
  })

  it('returns the original response untouched', async () => {
    const sink = fakeSink()
    const wrapped = withHttpLogging(async () => new Response('body', { status: 201 }), logger(sink))
    const res = await wrapped('https://h.example/a')
    expect(res.status).toBe(201)
    await expect(res.text()).resolves.toBe('body')
  })
})
