import { useEffect } from 'react'
import type { TodoReminderPermission } from '@common/ipc'
import { rendererLogger } from '@renderer/shared/logging/logger'
import { createStore } from '@renderer/shared/store/createStore'
import * as api from './ipc'

interface ReminderPermissionState {
  permission: TodoReminderPermission
  dismissed: boolean
}

// Window lifetime: leaving TODO preserves dismissal; a new renderer starts a new session.
export const useReminderPermissionStore = createStore<ReminderPermissionState>()(() => ({
  permission: 'unknown',
  dismissed: false
}))

export function useReminderPermission(hasTimedOpenTask: boolean): void {
  useEffect(() => {
    let active = true
    let revision = 0
    let interval: ReturnType<typeof setInterval> | undefined
    const refresh = async (): Promise<void> => {
      const request = ++revision
      let permission: TodoReminderPermission
      try {
        permission = await api.getReminderPermission()
      } catch (err) {
        rendererLogger().child('todo').warn('could not read reminder permission', { err })
        permission = 'error'
      }
      if (!active || request !== revision) return
      useReminderPermissionStore.setState(permission === 'authorized' || permission === 'provisional'
        ? { permission, dismissed: false } : { permission })
    }
    const visible = (): boolean => document.visibilityState === 'visible'
    const onFocus = (): void => { if (visible()) void refresh() }
    const updatePolling = (): void => {
      clearInterval(interval)
      interval = visible() && hasTimedOpenTask ? setInterval(() => void refresh(), 5000) : undefined
    }
    const onVisibility = (): void => {
      onFocus()
      updatePolling()
    }
    void refresh()
    updatePolling()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      active = false
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [hasTimedOpenTask])
}
