import { expect, test } from 'bun:test'
import { createBedrockEmbedder } from './embedder'

// Gated: run with `LIVE_BEDROCK=1` and AWS credentials (e.g. through infisical run).
test.skipIf(process.env.LIVE_BEDROCK !== '1')(
  'live Cohere returns the stated dimension',
  async () => {
    const embedder = createBedrockEmbedder({
      region: process.env.AWS_REGION ?? 'us-east-1',
      timeoutMs: 15_000,
    })
    const signal = new AbortController().signal
    const [a, b] = await embedder.embed(['enterprise pricing', ''], { purpose: 'document', signal })
    const [q] = await embedder.embed(['what does it cost'], { purpose: 'query', signal })
    expect(a).toHaveLength(embedder.dimensions)
    expect(b).toHaveLength(embedder.dimensions)
    expect(q).toHaveLength(embedder.dimensions)
    console.log('live dims', a?.length)
  }
)
