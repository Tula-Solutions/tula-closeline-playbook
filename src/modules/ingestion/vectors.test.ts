import { describe, expect, test } from 'bun:test'
import { chunksArtifactSchema, pagesArtifactSchema } from './vectors'

const env = { CHUNK_MAX_CHARS: 1600, MAX_CHUNKS_PER_DOCUMENT: 2, MAX_TEXT_CHARS_PER_DOCUMENT: 50 }
const chunk = (text: string, index = 0) => ({ index, page: 1, pageEnd: 1, heading: '', text })

describe('the pipeline artifacts are bounded by the settings', () => {
  test('a chunk longer than the maximum, a heading longer than 200 and too many chunks are refused', () => {
    const schema = chunksArtifactSchema(env)
    expect(schema.safeParse({ chunks: [chunk('x'.repeat(1600))] }).success).toBe(true)
    expect(schema.safeParse({ chunks: [chunk('x'.repeat(1601))] }).success).toBe(false)
    expect(
      schema.safeParse({ chunks: [{ ...chunk('x'), heading: 'h'.repeat(201) }] }).success
    ).toBe(false)
    expect(
      schema.safeParse({ chunks: [chunk('a', 0), chunk('b', 1), chunk('c', 2)] }).success
    ).toBe(false)
  })

  test('a page longer than the text limit is refused', () => {
    const schema = pagesArtifactSchema(env)
    expect(schema.safeParse({ pages: [{ number: 1, text: 'x'.repeat(50) }] }).success).toBe(true)
    expect(schema.safeParse({ pages: [{ number: 1, text: 'x'.repeat(51) }] }).success).toBe(false)
  })
})
