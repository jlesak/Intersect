import { describe, expect, test } from 'vitest'
import { reminderId, taskIdFromReminderId } from './todoReminder'

describe('TODO reminder ids', () => {
  test('a task id survives the round trip through its reminder id', () => {
    expect(taskIdFromReminderId(reminderId('abc_123'))).toBe('abc_123')
  })

  test('an id from another notification is not a reminder', () => {
    expect(taskIdFromReminderId('5d0c2a51-6f9e-4bb4-8f39-0a8c55e3c2d1')).toBeNull()
    expect(taskIdFromReminderId('workspace:tab')).toBeNull()
  })

  test('the bare prefix and values that are not strings are not reminders', () => {
    expect(taskIdFromReminderId('todo-reminder:')).toBeNull()
    expect(taskIdFromReminderId(undefined)).toBeNull()
    expect(taskIdFromReminderId(42)).toBeNull()
  })
})
