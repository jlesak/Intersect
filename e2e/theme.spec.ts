import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

const APP_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js')

// Guards the approved design tokens: slate background, cyan accent, 14px base typography.
test('applies the Design 2.0 slate+cyan theme tokens at runtime', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'intersect-theme-'))
  const app = await electron.launch({
    args: [APP_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, INTERSECT_E2E: '1' }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.ix-wordmark__name')

  const tokens = await win.evaluate(() => {
    const cs = getComputedStyle(document.documentElement)
    const body = getComputedStyle(document.body)
    return {
      bg: cs.getPropertyValue('--bg').trim(),
      panel: cs.getPropertyValue('--panel').trim(),
      accent: cs.getPropertyValue('--accent').trim(),
      accentHover: cs.getPropertyValue('--accent-hover').trim(),
      text: cs.getPropertyValue('--text').trim(),
      statusWorking: cs.getPropertyValue('--status-working').trim(),
      statusWaiting: cs.getPropertyValue('--status-waiting').trim(),
      statusDone: cs.getPropertyValue('--status-done').trim(),
      radius: cs.getPropertyValue('--radius').trim(),
      radiusSm: cs.getPropertyValue('--radius-sm').trim(),
      radiusLg: cs.getPropertyValue('--radius-lg').trim(),
      bodyBg: body.backgroundColor,
      bodyFontSize: body.fontSize,
      bodyLineHeight: body.lineHeight,
      bodyColor: body.color
    }
  })

  expect(tokens.bg).toBe('#171d28')
  expect(tokens.panel).toBe('#1d2532')
  expect(tokens.accent).toBe('#4cc9e8')
  expect(tokens.accentHover).toBe('#72d6ef')
  expect(tokens.text).toBe('#edf1f7')
  expect(tokens.statusWorking).toBe('#5b9dd9')
  expect(tokens.statusWaiting).toBe('#f0c53d')
  expect(tokens.statusDone).toBe('#5fd68a')
  expect(tokens.radius).toBe('8px')
  expect(tokens.radiusSm).toBe('6px')
  expect(tokens.radiusLg).toBe('12px')
  expect(tokens.bodyBg).toBe('rgb(23, 29, 40)')
  expect(tokens.bodyFontSize).toBe('14px')
  // line-height 1.55 * 14px = 21.7px
  expect(tokens.bodyLineHeight).toBe('21.7px')
  expect(tokens.bodyColor).toBe('rgb(237, 241, 247)')

  await win.screenshot({ path: join(__dirname, '..', 'e2e-artifacts', 'uat-gh41-theme.png') })
  await app.close()
})
