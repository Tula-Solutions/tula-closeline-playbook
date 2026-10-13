import { formatId, type OrganizationId } from 'tula-closeline-contract'
import * as Documents from '~/modules/document/service'
import {
  createTestDeps,
  newOrganizationId,
  newUserId,
  type TestDeps,
  type TestDepsOverrides,
} from '~/testing'

/** The paragraphs of a text file with `count` distinct, short paragraphs, so it gives about one chunk each. */
export function paragraphs(count: number, seed = 'p'): string {
  return Array.from(
    { length: count },
    (_, i) => `Paragraph ${seed} number ${i} says something distinct about topic ${seed}${i}.`
  ).join('\n\n')
}

/** Text that makes one chunk per paragraph, because each paragraph is above the minimum and the next would pass the target. */
export function bigParagraphs(count: number, seed = 'p'): string {
  return Array.from(
    { length: count },
    (_, i) => `${`Section ${seed} ${i} `.repeat(60)}ends here.`
  ).join('\n\n')
}

/** A pipeline under test: deps over the memory doubles, an Owner of one Organization and the calls a test makes. */
export type PipelineHarness = {
  deps: TestDeps
  organizationId: OrganizationId
  /** Another Organization's owner context. */
  other: () => Documents.CallContext
  context: Documents.CallContext
  /** Uploads a text file (or bytes) as the Owner; returns the document id. */
  upload(name: string, content: string | Uint8Array, options?: { key?: string }): Promise<string>
  /** The document row of the Owner's Organization. */
  document(id: string): ReturnType<TestDeps['database']['documents']>[number] | undefined
  /** The ids of the vectors a document has in an Organization's index. */
  vectorIds(documentId: string, organizationId?: string): Promise<string[]>
  /** Runs the job loop's pass to the end, moving virtual time on by `ms` while it runs. */
  pass(ms?: number): Promise<number>
}

/** Builds a {@link PipelineHarness}; `overrides` go to {@link createTestDeps}. */
export function createPipelineHarness(overrides: TestDepsOverrides = {}): PipelineHarness {
  const deps = createTestDeps(overrides)
  const organizationId = newOrganizationId()
  const contextFor = (id: OrganizationId): Documents.CallContext => ({
    userId: newUserId(),
    organizationId: id,
    role: 'owner',
    requestId: formatId('req', crypto.randomUUID()),
  })
  const context = contextFor(organizationId)
  const probe = Array.from({ length: deps.embedder.dimensions }, (_, i) => (i === 0 ? 1 : 0.5))
  return {
    deps,
    organizationId,
    context,
    other: () => contextFor(newOrganizationId()),
    upload: async (name, content, options = {}) => {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
      const result = await Documents.upload(deps, context, {
        fileName: name,
        declaredMediaType: null,
        bytes,
        idempotencyKey: options.key,
      })
      return result.document.id
    },
    document: (id) => deps.database.documents(organizationId).find((d) => d.id === id),
    vectorIds: async (documentId, org = organizationId) =>
      (
        await deps.vectors.search(org, {
          vector: probe,
          topK: 100,
          filter: { document_id: documentId },
        })
      )
        .map((hit) => hit.id)
        .sort(),
    pass: async (ms = 0) => {
      const running = deps.workers.ingestion.runPass()
      if (ms > 0) {
        await deps.time.advance(ms)
      }
      return running
    },
  }
}

/** The `outcome` of every `an ingestion job ended` log line, in order. */
export function jobOutcomes(deps: TestDeps): string[] {
  return deps.logLines
    .map((line) => JSON.parse(line) as { msg?: string; outcome?: string })
    .filter((line) => line.msg === 'an ingestion job ended')
    .map((line) => String(line.outcome))
}

/** Every value of `field` in log lines whose message is `message`. */
export function logged(deps: TestDeps, message: string): Record<string, unknown>[] {
  return deps.logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.msg === message)
}
