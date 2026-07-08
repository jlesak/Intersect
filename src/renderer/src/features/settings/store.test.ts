import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AppSettings } from '@common/domain'

vi.mock('./ipc')
vi.mock('@renderer/shared/ui/toast')
import * as api from './ipc'
import { INITIAL_NOTIFICATIONS, useSettingsStore } from './store'

const mocked = vi.mocked(api)

const settings = (over: Partial<AppSettings> = {}): AppSettings => ({
  notifications: { enabled: true, working: false, waiting: true, done: true, sound: true },
  ado: { orgUrl: 'https://devops.example.com', project: 'SPOT', repository: 'app', pat: 'pat-1' },
  adoFallback: { orgUrl: 'https://fallback', project: 'FB', hasPat: true },
  appearance: { terminalFontSize: 14 },
  ...over
})

const reset = (): void => {
  useSettingsStore.setState(
    {
      status: 'idle',
      error: null,
      notifications: INITIAL_NOTIFICATIONS,
      ado: { orgUrl: '', project: '', repository: '', pat: '' },
      adoFallback: { orgUrl: '', project: '', hasPat: false },
      terminalFontSize: 12.5,
      adoTest: { status: 'idle' }
    },
    false
  )
}

beforeEach(() => {
  reset()
  vi.clearAllMocks()
  // Mutations answer with the fresh settings; the store ignores the payload, so any works.
  mocked.setNotifications.mockResolvedValue(settings())
  mocked.setAdo.mockResolvedValue(settings())
  mocked.setTerminalFontSize.mockResolvedValue(settings())
})

describe('load', () => {
  test('hydrates every category and is ready', async () => {
    mocked.get.mockResolvedValue(settings())
    await useSettingsStore.getState().load()
    const s = useSettingsStore.getState()
    expect(s.status).toBe('ready')
    expect(s.ado.orgUrl).toBe('https://devops.example.com')
    expect(s.adoFallback).toEqual({ orgUrl: 'https://fallback', project: 'FB', hasPat: true })
    expect(s.terminalFontSize).toBe(14)
  })

  test('sets error status when the IPC call fails', async () => {
    mocked.get.mockRejectedValue(new Error('db gone'))
    await useSettingsStore.getState().load()
    expect(useSettingsStore.getState().status).toBe('error')
    expect(useSettingsStore.getState().error).toMatch(/db gone/)
  })
})

describe('setNotification', () => {
  test('flips the toggle locally and persists the whole document', async () => {
    await useSettingsStore.getState().setNotification('working', true)
    expect(useSettingsStore.getState().notifications.working).toBe(true)
    expect(mocked.setNotifications).toHaveBeenCalledWith({ ...INITIAL_NOTIFICATIONS, working: true })
  })

  test('keeps the optimistic value even when persisting fails (next load resyncs)', async () => {
    mocked.setNotifications.mockRejectedValue(new Error('nope'))
    await useSettingsStore.getState().setNotification('enabled', false)
    expect(useSettingsStore.getState().notifications.enabled).toBe(false)
  })
})

describe('setAdoField', () => {
  test('updates the field, resets a stale test result, and persists', async () => {
    useSettingsStore.setState({ adoTest: { status: 'success', displayName: 'Jan' } })
    await useSettingsStore.getState().setAdoField('project', 'FID2507')
    const s = useSettingsStore.getState()
    expect(s.ado.project).toBe('FID2507')
    expect(s.adoTest).toEqual({ status: 'idle' })
    expect(mocked.setAdo).toHaveBeenCalledWith(expect.objectContaining({ project: 'FID2507' }))
  })
})

describe('setTerminalFontSize', () => {
  test('updates the live value at once (terminals subscribe) but debounces the persist', () => {
    useSettingsStore.getState().setTerminalFontSize(16)
    expect(useSettingsStore.getState().terminalFontSize).toBe(16)
    expect(mocked.setTerminalFontSize).not.toHaveBeenCalled()

    useSettingsStore.getState().commitTerminalFontSize()
    expect(mocked.setTerminalFontSize).toHaveBeenCalledWith(16)
  })

  test('a drag burst persists only the final value once committed', () => {
    const s = useSettingsStore.getState()
    s.setTerminalFontSize(11)
    s.setTerminalFontSize(12)
    s.setTerminalFontSize(13)
    expect(useSettingsStore.getState().terminalFontSize).toBe(13)
    expect(mocked.setTerminalFontSize).not.toHaveBeenCalled()

    s.commitTerminalFontSize()
    expect(mocked.setTerminalFontSize).toHaveBeenCalledTimes(1)
    expect(mocked.setTerminalFontSize).toHaveBeenCalledWith(13)
  })
})

describe('testConnection', () => {
  test('records a success with the authenticated user', async () => {
    useSettingsStore.setState({
      ado: { orgUrl: 'https://x', project: 'p', repository: 'r', pat: 't' }
    })
    mocked.testAdoConnection.mockResolvedValue({ ok: true, displayName: 'Jan Lesák' })
    const pending = useSettingsStore.getState().testConnection()
    expect(useSettingsStore.getState().adoTest).toEqual({ status: 'testing' })
    await pending
    expect(useSettingsStore.getState().adoTest).toEqual({
      status: 'success',
      displayName: 'Jan Lesák'
    })
    expect(mocked.testAdoConnection).toHaveBeenCalledWith({
      orgUrl: 'https://x',
      project: 'p',
      repository: 'r',
      pat: 't'
    })
  })

  test('records a failure value inline', async () => {
    mocked.testAdoConnection.mockResolvedValue({ ok: false, error: 'HTTP 401' })
    await useSettingsStore.getState().testConnection()
    expect(useSettingsStore.getState().adoTest).toEqual({ status: 'error', error: 'HTTP 401' })
  })

  test('records a thrown IPC error inline too', async () => {
    mocked.testAdoConnection.mockRejectedValue(new Error('bridge gone'))
    await useSettingsStore.getState().testConnection()
    expect(useSettingsStore.getState().adoTest).toEqual({
      status: 'error',
      error: 'bridge gone'
    })
  })
})
