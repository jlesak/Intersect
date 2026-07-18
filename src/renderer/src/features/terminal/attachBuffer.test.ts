import { describe, expect, test } from 'vitest'
import { drainAfterSeq } from './attachBuffer'

describe('drainAfterSeq', () => {
  test('drops chunks the snapshot already contains and keeps the newer ones in order', () => {
    const buffered = [
      { data: 'a', seq: 1 },
      { data: 'b', seq: 2 },
      { data: 'c', seq: 3 },
      { data: 'd', seq: 4 }
    ]
    expect(drainAfterSeq(buffered, 2)).toEqual(['c', 'd'])
  })

  test('keeps everything when the snapshot predates the whole buffer', () => {
    expect(
      drainAfterSeq(
        [
          { data: 'a', seq: 5 },
          { data: 'b', seq: 6 }
        ],
        4
      )
    ).toEqual(['a', 'b'])
  })

  test('drops everything when the snapshot already contains the whole buffer', () => {
    expect(
      drainAfterSeq(
        [
          { data: 'a', seq: 1 },
          { data: 'b', seq: 2 }
        ],
        2
      )
    ).toEqual([])
  })

  test('keeps unnumbered chunks - they cannot be proven duplicated', () => {
    expect(drainAfterSeq([{ data: 'a', seq: 1 }, { data: 'b' }, { data: 'c', seq: 3 }], 2)).toEqual(
      ['b', 'c']
    )
  })

  test('an empty buffer drains to nothing', () => {
    expect(drainAfterSeq([], 10)).toEqual([])
  })
})
