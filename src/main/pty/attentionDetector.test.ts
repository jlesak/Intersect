import { describe, expect, it } from 'vitest'
import { createAttentionDetector } from './attentionDetector'

describe('createAttentionDetector', () => {
  it('detects the idle marker in a single chunk', () => {
    const detector = createAttentionDetector()
    expect(detector.push('s1', 'before \x1b]9;INTERSECT_IDLE\x07 after')).toBe('idle')
  })

  it('detects the permission marker in a single chunk', () => {
    const detector = createAttentionDetector()
    expect(detector.push('s1', '\x1b]9;INTERSECT_PERMISSION\x07')).toBe('permission')
  })

  it('returns null for ordinary output, including near-miss lookalikes', () => {
    const detector = createAttentionDetector()
    expect(detector.push('s1', 'just some regular shell output')).toBeNull()
    expect(detector.push('s1', 'the word INTERSECT appears here')).toBeNull()
    expect(detector.push('s1', 'a lone bell \x07 rings')).toBeNull()
    expect(detector.push('s1', '\x1b]9;Some Claude message\x07')).toBeNull()
  })

  it('does not match the bare token without its OSC 9 wrapper (grep/file-content safety)', () => {
    const detector = createAttentionDetector()
    // The token appearing as plain text - e.g. grepping this codebase inside a Claude tab - must
    // not fire; only the full ESC ] 9 ; <token> BEL sequence counts.
    expect(detector.push('s1', 'export const IDLE_TOKEN = "INTERSECT_IDLE"')).toBeNull()
    expect(detector.push('s2', 'echo INTERSECT_PERMISSION')).toBeNull()
  })

  it('detects a marker split across two chunks for the same session', () => {
    const detector = createAttentionDetector()
    expect(detector.push('s1', 'prefix \x1b]9;INTERSECT_ID')).toBeNull()
    expect(detector.push('s1', 'LE\x07 suffix')).toBe('idle')
  })

  it('keeps split-marker state isolated per session', () => {
    const detector = createAttentionDetector()
    expect(detector.push('s1', '\x1b]9;INTERSECT_ID')).toBeNull()
    expect(detector.push('s2', 'unrelated output on another session')).toBeNull()
    expect(detector.push('s2', 'LE\x07')).toBeNull()
    expect(detector.push('s1', 'LE\x07')).toBe('idle')
  })

  it('resolves to permission when both markers appear in one chunk', () => {
    const detector = createAttentionDetector()
    const chunk = `\x1b]9;INTERSECT_IDLE\x07 ... \x1b]9;INTERSECT_PERMISSION\x07`
    expect(detector.push('s1', chunk)).toBe('permission')
  })

  it('forget clears the buffered tail so a later half-marker cannot complete it', () => {
    const detector = createAttentionDetector()
    expect(detector.push('s1', '\x1b]9;INTERSECT_ID')).toBeNull()
    detector.forget('s1')
    expect(detector.push('s1', 'LE\x07')).toBeNull()
  })
})
