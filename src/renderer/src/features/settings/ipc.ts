import type {
  AdoConnectionResult,
  AdoSettings,
  AppSettings,
  NotificationSettings,
  ReviewSettings,
  SessionSettings
} from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

// Thin, mockable seam between the settings store and the preload bridge.
export const get = (): Promise<AppSettings> => ipc().settings.get()
export const setNotifications = (notifications: NotificationSettings): Promise<AppSettings> =>
  ipc().settings.setNotifications(notifications)
export const setAdo = (ado: AdoSettings): Promise<AppSettings> => ipc().settings.setAdo(ado)
export const setTerminalFontSize = (px: number): Promise<AppSettings> =>
  ipc().settings.setTerminalFontSize(px)
export const setReview = (review: ReviewSettings): Promise<AppSettings> =>
  ipc().settings.setReview(review)
export const setSession = (session: SessionSettings): Promise<AppSettings> =>
  ipc().settings.setSession(session)
export const testAdoConnection = (ado: AdoSettings): Promise<AdoConnectionResult> =>
  ipc().settings.testAdoConnection(ado)
