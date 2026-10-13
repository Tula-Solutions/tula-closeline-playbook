import { describe, expect, test } from 'bun:test'
import { embedderBehaviour } from '~/ports/embedder.behaviour'
import { createMemoryEmbedder } from './embedder'

embedderBehaviour('memory embedder', () => createMemoryEmbedder({ dimensions: 64 }))

const signal = new AbortController().signal

function cosine(a: number[], b: number[]): number {
  return a.reduce((sum, part, index) => sum + part * (b[index] ?? 0), 0)
}

describe('memory embedder specifics', () => {
  test('is deterministic, and texts that share words are closer than texts that do not', async () => {
    const embedder = createMemoryEmbedder({ dimensions: 512 })

    const [pricing, pricingPlans, weather] = await embedder.embed(
      ['enterprise pricing plans', 'pricing plans for enterprise', 'rain tomorrow afternoon'],
      { purpose: 'document', signal }
    )
    const [again] = await embedder.embed(['enterprise pricing plans'], { purpose: 'query', signal })

    expect(again).toEqual(pricing)
    expect(cosine(pricing ?? [], pricingPlans ?? [])).toBeGreaterThan(
      cosine(pricing ?? [], weather ?? [])
    )
  })

  test('records what it was asked and why', async () => {
    const embedder = createMemoryEmbedder({ dimensions: 8, model: 'fake-v1' })

    await embedder.embed(['a', 'b'], { purpose: 'query', signal })

    expect(embedder.model).toBe('fake-v1')
    expect(embedder.calls).toEqual([{ texts: ['a', 'b'], purpose: 'query' }])
  })
})
