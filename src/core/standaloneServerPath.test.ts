import { describe, expect, test } from 'vitest'
import { standaloneServerPath } from './standaloneServerPath'

describe('standaloneServerPath', () => {
  test('maps a packaged path onto the unpacked tree', () => {
    expect(standaloneServerPath('/Apps/Intersect.app/Contents/Resources/app.asar/out/main', 'draftServer.js')).toBe(
      '/Apps/Intersect.app/Contents/Resources/app.asar.unpacked/out/main/draftServer.js'
    )
  })

  test('leaves a development path untouched', () => {
    expect(standaloneServerPath('/Users/me/Intersect/out/main', 'draftServer.js')).toBe(
      '/Users/me/Intersect/out/main/draftServer.js'
    )
  })

  test('does not match a directory that merely starts with app.asar', () => {
    expect(standaloneServerPath('/Users/me/app.asarted/out/main', 'draftServer.js')).toBe(
      '/Users/me/app.asarted/out/main/draftServer.js'
    )
  })

  test('maps a bundle that sits directly in the archive root', () => {
    expect(standaloneServerPath('/Apps/x/app.asar', 'draftServer.js')).toBe(
      '/Apps/x/app.asar.unpacked/draftServer.js'
    )
  })
})
