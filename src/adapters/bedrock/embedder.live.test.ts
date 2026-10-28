import { expect, test } from 'bun:test'
import { createBedrockEmbedder } from './embedder'

// Gated: run with `LIVE_BEDROCK=1` and AWS credentials (e.g. through infisical run).
test.skipIf(process.env.LIVE_BEDROCK !== '1')(
  'live Titan returns the stated dimension',
  async () => {
    const embedder = createBedrockEmbedder({
      region: process.env.AWS_REGION ?? 'us-east-1',
      timeoutMs: 15_000,
    })
    const [a, b] = await embedder.embed(['enterprise pricing', ''], {
      purpose: 'query',
      signal: new AbortController().signal,
    })
    expect(a).toHaveLength(embedder.dimensions)
    expect(b).toHaveLength(embedder.dimensions)
    console.log('live dims', a?.length)
  }
)
