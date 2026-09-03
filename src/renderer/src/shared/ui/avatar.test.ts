import { describe, expect, test } from 'vitest'
import { avatarColor, initials } from './avatar'

describe('initials', () => {
  test.each([
    ['Jan Lesák', 'JL'],
    ['Marek K.', 'MK'],
    ['  Tereza   Nova  ', 'TN'],
    ['Cher', 'C'],
    ['anna beata carla', 'AB'],
    ['', '?']
  ])('%s -> %s', (name, expected) => {
    expect(initials(name)).toBe(expected)
  })
})

describe('avatarColor', () => {
  test('the same name always gets the same colour', () => {
    expect(avatarColor('Jan Lesák')).toBe(avatarColor('Jan Lesák'))
  })

  test('it answers with a colour for any name, the empty one included', () => {
    for (const name of ['', 'A', 'Jan Lesák', 'Marek Kral', 'x'.repeat(400)]) {
      expect(avatarColor(name)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  test('names that differ are spread over the palette rather than sharing one colour', () => {
    const names = ['Jan Lesák', 'Marek Kral', 'Eva Novak', 'Petr Vala', 'Nikola Rezkova']
    expect(new Set(names.map(avatarColor)).size).toBeGreaterThan(1)
  })
})
