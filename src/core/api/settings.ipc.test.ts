import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AdoConnectionResult, AdoSettings } from '@common/domain'
import { Channel, type IpcApi } from '@common/ipc'
import { makeTestDb } from '../db/testkit'
import {
  createSettingsRepo,
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_REVIEW_SETTINGS,
  DEFAULT_SESSION_SETTINGS,
  type SettingsRepo
} from '../db/settingsRepo'
import { createSettingsHandlers, settingsWireRoutes } from './settings.ipc'

const FALLBACK_ADO: AdoSettings = {
  orgUrl: 'https://devops.example.com/tfs/Collection',
  project: 'SPOT',
  repository: '',
  pat: 'env-pat'
}

describe('settings handlers', () => {
  let settings: SettingsRepo
  let testConnection: ReturnType<typeof vi.fn<(ado: AdoSettings) => Promise<AdoConnectionResult>>>
  let adoSettingsChanged: ReturnType<typeof vi.fn<() => Promise<void>>>
  let h: IpcApi['settings']

  beforeEach(() => {
    settings = createSettingsRepo(makeTestDb())
    testConnection = vi
      .fn<(ado: AdoSettings) => Promise<AdoConnectionResult>>()
      .mockResolvedValue({ ok: true, displayName: 'Jan' })
    adoSettingsChanged = vi.fn<() => Promise<void>>().mockResolvedValue()
    h = createSettingsHandlers({
      settings,
      fallbackAdo: () => ({ ...FALLBACK_ADO }),
      testConnection,
      adoSettingsChanged
    })
  })

  test('get returns an empty ADO form plus the env-derived fallback as a hint when nothing is saved', async () => {
    expect(await h.get()).toEqual({
      notifications: DEFAULT_NOTIFICATION_SETTINGS,
      ado: { orgUrl: '', project: '', repository: '', pat: '' },
      adoFallback: { orgUrl: FALLBACK_ADO.orgUrl, project: FALLBACK_ADO.project, hasPat: true },
      appearance: DEFAULT_APPEARANCE_SETTINGS,
      review: DEFAULT_REVIEW_SETTINGS,
      session: DEFAULT_SESSION_SETTINGS
    })
  })

  test('setSession persists the auto-resume toggle and returns the fresh settings', async () => {
    const result = await h.setSession({ autoResume: false })
    expect(result.session).toEqual({ autoResume: false })
    expect(settings.getSession()).toEqual({ autoResume: false })
  })

  test('setSession rejects a non-boolean autoResume', async () => {
    await expect(
      h.setSession({ autoResume: 'yes' as unknown as boolean })
    ).rejects.toThrow(/autoResume must be a boolean/)
  })

  test('get never leaks the fallback PAT to the renderer, only whether one exists', async () => {
    const withoutPat = createSettingsHandlers({
      settings,
      fallbackAdo: () => ({ ...FALLBACK_ADO, pat: '' }),
      testConnection,
      adoSettingsChanged
    })
    expect((await withoutPat.get()).adoFallback).toEqual({
      orgUrl: FALLBACK_ADO.orgUrl,
      project: FALLBACK_ADO.project,
      hasPat: false
    })
    // Whatever the renderer receives, the raw token string is never part of it.
    expect(JSON.stringify(await h.get())).not.toContain('env-pat')
  })

  test('setNotifications persists and returns the fresh settings', async () => {
    const next = { enabled: false, working: true, waiting: true, done: false, sound: false }
    const result = await h.setNotifications(next)
    expect(result.notifications).toEqual(next)
    expect(settings.getNotifications()).toEqual(next)
  })

  test('setAdo trims fields, persists, and saved values win over the fallback', async () => {
    const result = await h.setAdo({
      orgUrl: ' https://other.example.com ',
      project: ' P1 ',
      repository: ' repo ',
      pat: ' my-pat '
    })
    expect(result.ado).toEqual({
      orgUrl: 'https://other.example.com',
      project: 'P1',
      repository: 'repo',
      pat: 'my-pat'
    })
    expect((await h.get()).ado.orgUrl).toBe('https://other.example.com')
  })

  test('setAdo notifies the ADO-settings-changed hook after persisting, so live clients reconnect', async () => {
    await h.setAdo({ orgUrl: 'https://o', project: 'p', repository: 'r', pat: 'new-pat' })
    expect(adoSettingsChanged).toHaveBeenCalledTimes(1)
    expect(settings.getSavedAdo()?.pat).toBe('new-pat')
  })

  test('setAdo with unchanged values does not reconnect the ADO client', async () => {
    const saved: AdoSettings = { orgUrl: 'https://o', project: 'p', repository: 'r', pat: 'pat' }
    await h.setAdo(saved)
    adoSettingsChanged.mockClear()
    await h.setAdo({ ...saved, orgUrl: ' https://o ' })
    expect(adoSettingsChanged).not.toHaveBeenCalled()
    expect(settings.getSavedAdo()).toEqual(saved)
  })

  test('a repository-only change persists without reconnecting the ADO client', async () => {
    await h.setAdo({ orgUrl: 'https://o', project: 'p', repository: 'r', pat: 'pat' })
    adoSettingsChanged.mockClear()
    await h.setAdo({ orgUrl: 'https://o', project: 'p', repository: 'other-repo', pat: 'pat' })
    expect(adoSettingsChanged).not.toHaveBeenCalled()
    expect(settings.getSavedAdo()?.repository).toBe('other-repo')
  })

  test('a connection-relevant change (org/project/PAT) reconnects the ADO client', async () => {
    await h.setAdo({ orgUrl: 'https://o', project: 'p', repository: 'r', pat: 'pat' })
    adoSettingsChanged.mockClear()
    await h.setAdo({ orgUrl: 'https://o', project: 'p', repository: 'r', pat: 'rotated' })
    expect(adoSettingsChanged).toHaveBeenCalledTimes(1)
  })

  test('other mutations do not touch the ADO-settings-changed hook', async () => {
    await h.setNotifications({ ...DEFAULT_NOTIFICATION_SETTINGS, sound: false })
    await h.setTerminalFontSize(14)
    await h.testAdoConnection(FALLBACK_ADO)
    expect(adoSettingsChanged).not.toHaveBeenCalled()
  })

  test('setTerminalFontSize clamps to the allowed range', async () => {
    expect((await h.setTerminalFontSize(14)).appearance.terminalFontSize).toBe(14)
    expect((await h.setTerminalFontSize(99)).appearance.terminalFontSize).toBe(20)
    expect((await h.setTerminalFontSize(2)).appearance.terminalFontSize).toBe(10)
    await expect(h.setTerminalFontSize(Number.NaN)).rejects.toThrow(/must be a number/)
  })

  test('setReview preserves the prompt exactly and returns the fresh settings', async () => {
    const prompt = '  Please review in English.\nDo not trim this line.  \n'
    const result = await h.setReview({ prompt })
    expect(result.review).toEqual({ prompt })
    expect(settings.getReview()).toEqual({ prompt })
  })

  test('setReview rejects a malformed payload instead of persisting it', async () => {
    await expect(h.setReview({ prompt: 42 } as unknown as { prompt: string })).rejects.toThrow(
      /must be a string/
    )
    await expect(h.setReview(null as unknown as { prompt: string })).rejects.toThrow(
      /must be a string/
    )
    expect(settings.getReview()).toEqual(DEFAULT_REVIEW_SETTINGS)
  })

  test('setReview persists only the prompt field, dropping extra keys', async () => {
    await h.setReview({ prompt: 'clean', extra: 'junk' } as unknown as { prompt: string })
    expect(settings.getReview()).toEqual({ prompt: 'clean' })
  })

  test('testAdoConnection probes the given form values without saving them', async () => {
    const typed: AdoSettings = { orgUrl: 'https://t', project: 'p', repository: 'r', pat: 'typed' }
    expect(await h.testAdoConnection(typed)).toEqual({ ok: true, displayName: 'Jan' })
    expect(testConnection).toHaveBeenCalledWith(typed)
    expect(settings.getSavedAdo()).toBeNull()
  })

  test('testAdoConnection fills blank form fields from the fallback so it probes the effective connection', async () => {
    await h.testAdoConnection({ orgUrl: '', project: '', repository: 'my-repo', pat: '' })
    expect(testConnection).toHaveBeenCalledWith({
      orgUrl: FALLBACK_ADO.orgUrl,
      project: FALLBACK_ADO.project,
      repository: 'my-repo',
      pat: 'env-pat'
    })
  })

  test('a test-connection throw crosses as a message-only Error', async () => {
    testConnection.mockRejectedValue('boom')
    await expect(h.testAdoConnection(FALLBACK_ADO)).rejects.toThrow(/boom/)
  })
})

describe('settingsWireRoutes', () => {
  test('binds the six request/response channels to the handlers', async () => {
    const h = createSettingsHandlers({
      settings: createSettingsRepo(makeTestDb()),
      fallbackAdo: () => ({ ...FALLBACK_ADO }),
      testConnection: () => Promise.resolve({ ok: true, displayName: 'Jan' }),
      adoSettingsChanged: () => Promise.resolve()
    })
    const routes = settingsWireRoutes(h)
    const call = (channel: string, ...args: unknown[]): unknown =>
      (routes[channel] as (...a: unknown[]) => unknown)(...args)

    expect(Object.keys(routes).sort()).toEqual(
      [
        Channel.settingsGet,
        Channel.settingsSetNotifications,
        Channel.settingsSetAdo,
        Channel.settingsSetTerminalFontSize,
        Channel.settingsSetReview,
        Channel.settingsSetSession,
        Channel.settingsTestAdoConnection
      ].sort()
    )

    const updated = (await call(Channel.settingsSetTerminalFontSize, 15)) as {
      appearance: { terminalFontSize: number }
    }
    expect(updated.appearance.terminalFontSize).toBe(15)

    const prompt = 'Review in my language\n'
    const reviewed = (await call(Channel.settingsSetReview, { prompt })) as {
      review: { prompt: string }
    }
    expect(reviewed.review.prompt).toBe(prompt)
  })
})
