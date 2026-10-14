import { describe, expect, test } from 'bun:test'
import { momentSnippet, momentSnippetSchema } from 'tula-closeline-contract'
import { attributeSnippet } from './snippet'

const WORDS = 'Our annual plan gives a volume discount to teams of ten seats or more. '

/** True when `text` holds a lone surrogate. */
const loneSurrogate = (text: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)

describe('attributeSnippet', () => {
  test('is the contract snippet when it already fits the store: plain text is cut at a word with an ellipsis', () => {
    const text = WORDS.repeat(20)

    const snippet = attributeSnippet(text)

    expect(snippet).toBe(momentSnippet(text))
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet.length).toBeLessThanOrEqual(512)
    expect(momentSnippetSchema.safeParse(snippet).success).toBe(true)
  })

  test('an emoji-heavy chunk ends at a whole word with an ellipsis, within 512 UTF-16 units', () => {
    const text = `${'😀 happy customers love our onboarding plan '.repeat(30)}`

    const snippet = attributeSnippet(text)

    expect(snippet.length).toBeLessThanOrEqual(512)
    expect(snippet.endsWith('…')).toBe(true)
    // The last word before the ellipsis is a whole word of the text, never a part of one.
    const last = snippet.slice(0, -1).split(' ').at(-1)
    expect(
      new Set(['😀', 'happy', 'customers', 'love', 'our', 'onboarding', 'plan']).has(last ?? '')
    ).toBe(true)
    expect(loneSurrogate(snippet)).toBe(false)
    expect(momentSnippetSchema.safeParse(snippet).success).toBe(true)
  })

  test('emoji in a plain-text chunk whose cut would fall inside a word still ends at a word', () => {
    const text = `${'😀'.repeat(60)} ${WORDS.repeat(15)}availability`

    const snippet = attributeSnippet(text)

    expect(snippet.length).toBeLessThanOrEqual(512)
    expect(snippet.endsWith('…')).toBe(true)
    expect(/\s…$/.test(snippet)).toBe(false)
    expect(snippet.slice(0, -1).endsWith(' ')).toBe(false)
    expect(loneSurrogate(snippet)).toBe(false)
  })

  test('a single word over 512 characters is still cut hard, with an ellipsis', () => {
    const word = 'a'.repeat(900)

    const snippet = attributeSnippet(word)

    expect(snippet).toBe(momentSnippet(word))
    expect(snippet.length).toBeLessThanOrEqual(512)
    expect(snippet.endsWith('…')).toBe(true)
  })

  test('a single emoji word over 512 units is cut hard at a code point, with an ellipsis', () => {
    const snippet = attributeSnippet('😀'.repeat(400))

    expect(snippet.length).toBeLessThanOrEqual(512)
    expect(snippet.endsWith('…')).toBe(true)
    expect(loneSurrogate(snippet)).toBe(false)
    expect(momentSnippetSchema.safeParse(snippet).success).toBe(true)
  })

  test('text that fits is returned whole, with no ellipsis', () => {
    expect(attributeSnippet('A short sentence about pricing.')).toBe(
      'A short sentence about pricing.'
    )
  })
})
