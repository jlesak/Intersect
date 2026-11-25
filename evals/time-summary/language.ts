import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

/** Independent local macOS language recognition, used only by the opt-in live evaluation. */
export function detectLanguages(texts: string[]): string[] {
  const script = resolve(__dirname, 'language.swift')
  const run = spawnSync('swift', [script], { input: JSON.stringify(texts), encoding: 'utf8',
    timeout: 30_000, maxBuffer: 64_000 })
  if (run.status !== 0) throw new Error('language-recognizer-failed')
  const result: unknown = JSON.parse(run.stdout)
  if (!Array.isArray(result) || result.length !== texts.length ||
    !result.every(value => typeof value === 'string')) throw new Error('language-result-invalid')
  return result
}
