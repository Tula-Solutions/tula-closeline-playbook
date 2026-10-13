import { describe, expect, test } from 'bun:test'
import type { Embedder } from './embedder'

/** The behaviour every {@link Embedder} must show; run it against each adapter. */
export function embedderBehaviour(name: string, make: () => Embedder): void {
  describe(`Embedder behaviour: ${name}`, () => {
    test('returns one finite, non-zero vector of the stated length per text, in order', async () => {
      const embedder = make()

      const vectors = await embedder.embed(['pricing', 'refunds', ''], {
        purpose: 'document',
        signal: new AbortController().signal,
      })

      expect(vectors).toHaveLength(3)
      for (const vector of vectors) {
        expect(vector).toHaveLength(embedder.dimensions)
        expect(vector.every(Number.isFinite)).toBe(true)
        expect(vector.some((part) => part !== 0)).toBe(true)
      }
    })

    test('an empty list gives an empty list', async () => {
      const embedder = make()

      expect(
        await embedder.embed([], { purpose: 'query', signal: new AbortController().signal })
      ).toEqual([])
    })

    test('an aborted signal rejects the call', async () => {
      const embedder = make()
      const controller = new AbortController()
      controller.abort()

      await expect(
        embedder.embed(['pricing'], { purpose: 'query', signal: controller.signal })
      ).rejects.toThrow()
    })

    test('names its model and a positive dimension count', () => {
      const embedder = make()

      expect(embedder.model.length).toBeGreaterThan(0)
      expect(embedder.dimensions).toBeGreaterThan(0)
    })
  })
}
