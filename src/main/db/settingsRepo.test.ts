import { beforeEach, describe, expect, test } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { makeTestDb } from './testkit'
import {
  createSettingsRepo,
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  type SettingsRepo
} from './settingsRepo'

describe('settingsRepo', () => {
  let db: DatabaseSync
  let repo: SettingsRepo

  beforeEach(() => {
    db = makeTestDb()
    repo = createSettingsRepo(db)
  })

  test('returns the defaults when nothing was ever saved', () => {
    expect(repo.getNotifications()).toEqual(DEFAULT_NOTIFICATION_SETTINGS)
    expect(repo.getAppearance()).toEqual(DEFAULT_APPEARANCE_SETTINGS)
    expect(repo.getSavedAdo()).toBeNull()
  })

  test('notifications round-trip', () => {
    repo.setNotifications({ enabled: false, working: true, waiting: false, done: true, sound: false })
    expect(repo.getNotifications()).toEqual({
      enabled: false,
      working: true,
      waiting: false,
      done: true,
      sound: false
    })
  })

  test('a notifications document missing fields falls back per field', () => {
    db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)').run(
      'settings.notifications',
      JSON.stringify({ enabled: false })
    )
    expect(repo.getNotifications()).toEqual({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: false })
  })

  test('corrupted JSON degrades to the defaults', () => {
    db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)').run(
      'settings.notifications',
      'not json'
    )
    db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)').run('settings.appearance', '[]')
    expect(repo.getNotifications()).toEqual(DEFAULT_NOTIFICATION_SETTINGS)
    expect(repo.getAppearance()).toEqual(DEFAULT_APPEARANCE_SETTINGS)
  })

  test('ado settings round-trip and overwrite', () => {
    const ado = {
      orgUrl: 'https://devops.example.com/tfs/Collection',
      project: 'FID2507',
      repository: 'intersect-app',
      pat: 'secret-pat'
    }
    repo.setAdo(ado)
    expect(repo.getSavedAdo()).toEqual(ado)

    repo.setAdo({ ...ado, project: 'OTHER' })
    expect(repo.getSavedAdo()?.project).toBe('OTHER')
  })

  test('appearance round-trips and clamps an out-of-range stored size', () => {
    repo.setAppearance({ terminalFontSize: 14 })
    expect(repo.getAppearance()).toEqual({ terminalFontSize: 14 })

    repo.setAppearance({ terminalFontSize: 99 })
    expect(repo.getAppearance().terminalFontSize).toBe(20)
    repo.setAppearance({ terminalFontSize: 1 })
    expect(repo.getAppearance().terminalFontSize).toBe(10)
  })

  test('saving one category does not touch the others', () => {
    repo.setAdo({ orgUrl: 'https://x', project: 'p', repository: 'r', pat: 't' })
    repo.setNotifications({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: false })
    expect(repo.getSavedAdo()?.orgUrl).toBe('https://x')
    expect(repo.getAppearance()).toEqual(DEFAULT_APPEARANCE_SETTINGS)
  })
})
