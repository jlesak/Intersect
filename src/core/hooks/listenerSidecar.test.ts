import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HOOK_TOKEN_FILENAME,
  readListenerSidecar,
  readOrCreateToken,
  writeListenerSidecar
} from './listenerSidecar'

describe('listenerSidecar', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'intersect-sidecar-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('readOrCreateToken', () => {
    it('creates a 64-hex-char token with owner-only permissions', () => {
      const token = readOrCreateToken(dir)
      expect(token).toMatch(/^[0-9a-f]{64}$/)
      const mode = statSync(join(dir, HOOK_TOKEN_FILENAME)).mode & 0o777
      expect(mode).toBe(0o600)
    })

    it('reuses an existing token instead of rotating it', () => {
      writeFileSync(join(dir, HOOK_TOKEN_FILENAME), 'existing-token\n')
      expect(readOrCreateToken(dir)).toBe('existing-token')
    })

    it('is stable across calls', () => {
      expect(readOrCreateToken(dir)).toBe(readOrCreateToken(dir))
    })
  })

  describe('write/readListenerSidecar', () => {
    it('round-trips port and timestamp, with owner-only permissions', () => {
      const file = join(dir, 'listener.json')
      writeListenerSidecar(file, { port: 7621, writtenAt: 123 })
      expect(readListenerSidecar(file)).toEqual({ port: 7621, writtenAt: 123 })
      expect(statSync(file).mode & 0o777).toBe(0o600)
    })

    it('overwrites atomically (no leftover tmp file)', () => {
      const file = join(dir, 'listener.json')
      writeListenerSidecar(file, { port: 7621, writtenAt: 1 })
      writeListenerSidecar(file, { port: 7622, writtenAt: 2 })
      expect(readListenerSidecar(file)?.port).toBe(7622)
      expect(() => readFileSync(`${file}.tmp`)).toThrow()
    })

    it('returns null for a missing or corrupt sidecar', () => {
      const file = join(dir, 'listener.json')
      expect(readListenerSidecar(file)).toBeNull()
      writeFileSync(file, 'not json')
      expect(readListenerSidecar(file)).toBeNull()
      writeFileSync(file, JSON.stringify({ port: 'nope' }))
      expect(readListenerSidecar(file)).toBeNull()
    })
  })
})
