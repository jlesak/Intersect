import { expect, test } from 'vitest'
import { detectLanguages } from './language'

test('local language check distinguishes Czech, Slovak and English counterexamples', () => {
  expect(detectLanguages([
    'Doplnil testy v projektu.',
    'Opravil jsem parser v projektu.',
    'Doplnil testy v projekte.',
    'I fixed the parser in the project.'
  ])).toEqual(['cs', 'cs', 'sk', 'en'])
})
