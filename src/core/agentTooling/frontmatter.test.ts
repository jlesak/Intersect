import { describe, expect, test } from 'vitest'
import { readFrontmatterField, splitFrontmatter, stripQuotes } from './frontmatter'

describe('splitFrontmatter', () => {
  test('splits a delimited block from the body', () => {
    const { frontmatter, body } = splitFrontmatter('---\nname: x\ndescription: y\n---\n\n# Title\nbody')
    expect(frontmatter).toBe('name: x\ndescription: y')
    expect(body).toBe('# Title\nbody')
  })

  test('treats a document without leading --- as all body', () => {
    const { frontmatter, body } = splitFrontmatter('# Just a doc\nno frontmatter')
    expect(frontmatter).toBe('')
    expect(body).toBe('# Just a doc\nno frontmatter')
  })

  test('falls back to all body when the closing --- is missing', () => {
    const raw = '---\nname: x\nno close here'
    const { frontmatter, body } = splitFrontmatter(raw)
    expect(frontmatter).toBe('')
    expect(body).toBe(raw)
  })

  test('an inline --- that is not on its own line does not close the block', () => {
    const { frontmatter } = splitFrontmatter('---\ndescription: a --- b\n---\nbody')
    expect(frontmatter).toBe('description: a --- b')
  })
})

describe('readFrontmatterField', () => {
  test('reads a simple single-line value', () => {
    expect(readFrontmatterField('model: opus\ntools: Read', 'model')).toBe('opus')
  })

  test('strips surrounding quotes', () => {
    expect(readFrontmatterField('description: "quoted value"', 'description')).toBe('quoted value')
    expect(readFrontmatterField("description: 'single'", 'description')).toBe('single')
  })

  test('accumulates indented continuation lines into one folded value', () => {
    const fm = 'description: first line\n  second line\n  third line\nmodel: opus'
    expect(readFrontmatterField(fm, 'description')).toBe('first line second line third line')
    // The continuation must not bleed into the next real key.
    expect(readFrontmatterField(fm, 'model')).toBe('opus')
  })

  test('returns empty string for an absent key', () => {
    expect(readFrontmatterField('name: x', 'description')).toBe('')
  })

  test('a bare key: with no value yields empty string', () => {
    expect(readFrontmatterField('description:', 'description')).toBe('')
  })
})

describe('stripQuotes', () => {
  test('leaves unquoted and mismatched values untouched', () => {
    expect(stripQuotes('plain')).toBe('plain')
    expect(stripQuotes('"only-left')).toBe('"only-left')
  })
})
