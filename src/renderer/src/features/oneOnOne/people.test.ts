import { describe, expect, test } from 'vitest'
import type { OtoRun } from '@common/domain'
import { groupRunsByPerson, peopleFromRuns, personKey } from './people'

const run = (id: string, person: string, createdAt: number): OtoRun => ({
  id,
  type: 'prep',
  person,
  vttPath: null,
  status: 'done',
  notionUrl: null,
  slackDraftCreated: false,
  slackChannelLink: null,
  resultMarkdown: null,
  error: null,
  createdAt,
  finishedAt: createdAt + 1000
})

describe('personKey', () => {
  test('case alone never makes a second person', () => {
    expect(personKey('marek')).toBe(personKey('Marek'))
    expect(personKey('MAREK')).toBe(personKey('Marek'))
  })

  test('spacing alone never makes a second person', () => {
    expect(personKey('  Marek   K  ')).toBe(personKey('Marek K'))
  })

  test('a trailing dot is spelling, not identity', () => {
    expect(personKey('Marek K.')).toBe(personKey('marek k'))
  })

  test('a different name stays a different person', () => {
    // Merging these needs a similarity rule that would eventually merge two real Mareks.
    expect(personKey('Marek')).not.toBe(personKey('marek k'))
  })

  test('a name of nothing but spaces has no identity at all', () => {
    expect(personKey('   ')).toBe('')
  })
})

describe('peopleFromRuns', () => {
  test('no runs means nobody to offer', () => {
    expect(peopleFromRuns([])).toEqual([])
  })

  test('everyone appears once, most recently used first', () => {
    expect(
      peopleFromRuns([run('1', 'Tereza N.', 300), run('2', 'Marek K.', 200), run('3', 'Aleš P.', 100)])
    ).toEqual(['Tereza N.', 'Marek K.', 'Aleš P.'])
  })

  test('recency is read off the runs rather than assumed from their order', () => {
    expect(peopleFromRuns([run('1', 'Marek K.', 100), run('2', 'Tereza N.', 300)])).toEqual([
      'Tereza N.',
      'Marek K.'
    ])
  })

  test('a name that drifted only in case or spacing is offered once, as last spelled', () => {
    expect(peopleFromRuns([run('1', 'Marek', 300), run('2', 'marek', 200)])).toEqual(['Marek'])
  })

  test('two genuinely different names are both offered', () => {
    expect(peopleFromRuns([run('1', 'Marek', 300), run('2', 'marek k', 200)])).toEqual([
      'Marek',
      'marek k'
    ])
  })

  test('a run started with no real name offers nothing', () => {
    expect(peopleFromRuns([run('1', '   ', 300)])).toEqual([])
  })
})

describe('groupRunsByPerson', () => {
  test('each person gets one group, newest run first inside it', () => {
    const groups = groupRunsByPerson([
      run('1', 'Marek K.', 100),
      run('2', 'Tereza N.', 400),
      run('3', 'Marek K.', 300),
      run('4', 'Tereza N.', 200)
    ])

    expect(groups.map((g) => g.person)).toEqual(['Tereza N.', 'Marek K.'])
    expect(groups[0].runs.map((r) => r.id)).toEqual(['2', '4'])
    expect(groups[1].runs.map((r) => r.id)).toEqual(['3', '1'])
  })

  test('a name that drifted stays one group, headed by its newest spelling', () => {
    const groups = groupRunsByPerson([run('1', 'marek k', 100), run('2', 'Marek K.', 300)])

    expect(groups).toHaveLength(1)
    expect(groups[0].person).toBe('Marek K.')
    expect(groups[0].runs.map((r) => r.id)).toEqual(['2', '1'])
  })

  test('no runs means no groups', () => {
    expect(groupRunsByPerson([])).toEqual([])
  })
})
