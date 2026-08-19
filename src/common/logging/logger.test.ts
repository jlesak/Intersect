import { describe, expect, it, vi } from 'vitest'
import { createLogger, parseLevel } from './logger'
import { fakeSink, readRecords } from './testSink'

describe('createLogger', () => {
  it('writes a record carrying process identity and scope', () => {
    const sink = fakeSink()
    const log = createLogger({
      sink,
      level: 'debug',
      proc: 'core',
      pid: 42,
      scope: 'jira',
      now: () => new Date('2026-07-28T09:00:00.000Z')
    })
    log.info('board fetched', { data: { issues: 12 } })
    expect(readRecords(sink)[0]).toMatchObject({
      ts: '2026-07-28T09:00:00.000Z',
      level: 'info',
      proc: 'core',
      pid: 42,
      scope: 'jira',
      msg: 'board fetched',
      data: { issues: 12 }
    })
  })

  it('drops records below the floor', () => {
    const sink = fakeSink()
    const log = createLogger({ sink, level: 'info', proc: 'main' })
    log.debug('noise')
    log.warn('kept')
    expect(readRecords(sink).map((r) => r.level)).toEqual(['warn'])
  })

  it('normalises a thrown value passed as err', () => {
    const sink = fakeSink()
    const log = createLogger({ sink, level: 'debug', proc: 'main' })
    log.error('failed', { err: new Error('boom') })
    expect(readRecords(sink)[0].err).toMatchObject({ name: 'Error', message: 'boom' })
  })

  it('child inherits configuration and overrides only the scope', () => {
    const sink = fakeSink()
    const log = createLogger({ sink, level: 'debug', proc: 'core', scope: 'lifecycle' })
    log.child('rpc').debug('served')
    expect(readRecords(sink)[0]).toMatchObject({ scope: 'rpc', proc: 'core' })
  })

  it('never lets a failing sink reach the caller', () => {
    const onSinkFailure = vi.fn()
    const log = createLogger({
      sink: {
        write: () => {
          throw new Error('disk gone')
        }
      },
      level: 'debug',
      proc: 'main',
      onSinkFailure
    })
    expect(() => log.error('anything')).not.toThrow()
    expect(onSinkFailure).toHaveBeenCalledTimes(1)
  })

  it('stops writing after the sink has failed once', () => {
    let calls = 0
    const log = createLogger({
      sink: {
        write: () => {
          calls += 1
          throw new Error('disk gone')
        }
      },
      level: 'debug',
      proc: 'main',
      onSinkFailure: () => {}
    })
    log.error('one')
    log.error('two')
    expect(calls).toBe(1)
  })

  it('caps the rate and reports what it dropped', () => {
    const sink = fakeSink()
    let ms = 0
    const log = createLogger({
      sink,
      level: 'debug',
      proc: 'core',
      maxRecordsPerSecond: 2,
      now: () => new Date(ms)
    })
    log.info('a')
    log.info('b')
    log.info('c')
    log.info('d')
    expect(sink.lines).toHaveLength(2)

    ms = 1500
    log.info('next window')
    const summary = readRecords(sink).find((r) => r.scope === 'log')
    expect(summary).toMatchObject({ level: 'warn', data: { dropped: 2 } })
  })

  it('shares one rate budget with its children', () => {
    const sink = fakeSink()
    const log = createLogger({
      sink,
      level: 'debug',
      proc: 'core',
      maxRecordsPerSecond: 1,
      now: () => new Date(0)
    })
    log.info('parent')
    log.child('rpc').info('child')
    expect(sink.lines).toHaveLength(1)
  })
})

describe('parseLevel', () => {
  it('accepts a known level', () => {
    expect(parseLevel('warn', 'info')).toBe('warn')
  })

  it('falls back on anything unrecognised', () => {
    expect(parseLevel('verbose', 'info')).toBe('info')
    expect(parseLevel(undefined, 'debug')).toBe('debug')
  })

  it('falls back on a name the level table merely inherits', () => {
    expect(parseLevel('constructor', 'info')).toBe('info')
    expect(parseLevel('toString', 'warn')).toBe('warn')
  })
})
