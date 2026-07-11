import { describe, expect, it } from 'vitest'
import { buildMarker, IDLE_TOKEN, PERMISSION_TOKEN, STOP_TOKEN } from './attentionMarkers'
import { createAttentionDetector, type AttentionAlert } from './attentionDetector'

describe('createAttentionDetector', () => {
  it('detects the idle marker in a single chunk', () => {
    const detector = createAttentionDetector()
    expect(detector.push('s1', `before ${buildMarker(IDLE_TOKEN)} after`)).toEqual({ kind: 'idle' })
  })

  it('detects the permission marker in a single chunk', () => {
    const detector = createAttentionDetector()
    expect(detector.push('s1', buildMarker(PERMISSION_TOKEN))).toEqual({ kind: 'permission' })
  })

  it('detects the stop marker in a single chunk', () => {
    const detector = createAttentionDetector()
    expect(detector.push('s1', buildMarker(STOP_TOKEN))).toEqual({ kind: 'stop' })
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

  it('decodes a base64 message payload carried alongside the token', () => {
    const detector = createAttentionDetector()
    const marker = buildMarker(PERMISSION_TOKEN, 'Claude needs your permission to use Bash')
    expect(detector.push('s1', marker)).toEqual({
      kind: 'permission',
      message: 'Claude needs your permission to use Bash'
    })
  })

  it('detects a marker split across two chunks for the same session', () => {
    const detector = createAttentionDetector()
    const marker = buildMarker(IDLE_TOKEN)
    const splitAt = Math.floor(marker.length / 2)
    expect(detector.push('s1', `prefix ${marker.slice(0, splitAt)}`)).toBeNull()
    expect(detector.push('s1', `${marker.slice(splitAt)} suffix`)).toEqual({ kind: 'idle' })
  })

  it('detects a message payload split across many chunks', () => {
    const detector = createAttentionDetector()
    const marker = buildMarker(PERMISSION_TOKEN, 'Claude needs your permission to use Bash')
    // Feed the marker one character at a time to exercise arbitrary split points mid-payload.
    let result: AttentionAlert | null = null
    for (const ch of marker) {
      result = detector.push('s1', ch)
    }
    expect(result).toEqual({
      kind: 'permission',
      message: 'Claude needs your permission to use Bash'
    })
  })

  it('keeps split-marker state isolated per session', () => {
    const detector = createAttentionDetector()
    const marker = buildMarker(IDLE_TOKEN)
    const splitAt = Math.floor(marker.length / 2)
    expect(detector.push('s1', marker.slice(0, splitAt))).toBeNull()
    expect(detector.push('s2', 'unrelated output on another session')).toBeNull()
    expect(detector.push('s2', marker.slice(splitAt))).toBeNull()
    expect(detector.push('s1', marker.slice(splitAt))).toEqual({ kind: 'idle' })
  })

  it('resolves to permission when both markers appear in one chunk', () => {
    const detector = createAttentionDetector()
    const chunk = `${buildMarker(IDLE_TOKEN)} ... ${buildMarker(PERMISSION_TOKEN)}`
    expect(detector.push('s1', chunk)).toEqual({ kind: 'permission' })
  })

  it('resolves to permission over stop when both appear in one chunk', () => {
    const detector = createAttentionDetector()
    const chunk = `${buildMarker(STOP_TOKEN)} ... ${buildMarker(PERMISSION_TOKEN)}`
    expect(detector.push('s1', chunk)).toEqual({ kind: 'permission' })
  })

  it('tolerates an invalid base64 payload rather than throwing', () => {
    const detector = createAttentionDetector()
    // Not valid base64 padding/content, but still only characters the payload charset allows.
    const marker = `\x1b]9;${PERMISSION_TOKEN};===\x07`
    expect(() => detector.push('s1', marker)).not.toThrow()
    expect(detector.push('s2', marker)?.kind).toBe('permission')
  })

  it('forget clears the buffered tail so a later half-marker cannot complete it', () => {
    const detector = createAttentionDetector()
    const marker = buildMarker(IDLE_TOKEN)
    const splitAt = Math.floor(marker.length / 2)
    expect(detector.push('s1', marker.slice(0, splitAt))).toBeNull()
    detector.forget('s1')
    expect(detector.push('s1', marker.slice(splitAt))).toBeNull()
  })
})
