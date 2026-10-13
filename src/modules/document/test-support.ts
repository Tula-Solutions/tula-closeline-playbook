import { spyOn } from 'bun:test'
import { type DocumentId, errorBodySchema, formatId, type Role } from 'tula-closeline-contract'
import type { PlaybookEnvelope } from '~/messages'
import {
  createTestApp,
  newOrganizationId,
  newUserId,
  TEST_INTERNAL_SECRET,
  type TestApp,
  type TestDepsOverrides,
  type TestIdentity,
} from '~/testing'

/** The path of the collection of documents. */
export const DOCUMENTS = '/v1/playbook/documents'

/** The internal secret the test environment accepts. */
export const INTERNAL_SECRET = TEST_INTERNAL_SECRET

/** A person with `role` in `organizationId`. */
export function personIn(organizationId: string, role: Role): TestIdentity {
  return {
    userId: newUserId(),
    organizationId: organizationId as TestIdentity['organizationId'],
    role,
  }
}

/** Bytes of a small, valid PDF-looking file that differ for each `seed`, so their hashes differ. */
export function pdfBytes(seed: string, extra = 0): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n% ${seed}\n${'x'.repeat(extra)}\n%%EOF\n`)
}

/** A multipart upload request body holding one `file` part. */
export function uploadForm(name: string, bytes: Uint8Array, type = 'application/pdf'): FormData {
  const form = new FormData()
  form.append('file', new File([bytes], name, { type }))
  return form
}

/** The decoded error code of a failed response. */
export async function errorCode(response: Response): Promise<string> {
  return errorBodySchema.parse(await response.json()).error.code
}

/** A test app plus the helpers every document test uses. */
export type DocumentHarness = TestApp & {
  /** Every message published to the queue, in order. */
  published: PlaybookEnvelope[]
  /** Slows or intercepts each publish: wait `delayMs`, then run `before` once if set. */
  publishing: { delayMs: number; before?: (() => Promise<void>) | undefined }
  /** The Organization the tests mostly use, and its people by role. */
  organizationId: string
  people: Record<Role, TestIdentity>
  /** Uploads `bytes` as `name` as `identity` (an Owner by default). */
  upload(
    name: string,
    bytes: Uint8Array,
    options?: { as?: TestIdentity; key?: string; headers?: Record<string, string> }
  ): Promise<Response>
  /** A request to a documents route as `identity`. */
  call(
    method: string,
    path: string,
    options?: { as?: TestIdentity | null; headers?: Record<string, string> }
  ): Promise<Response>
  /** The ids of the objects stored for an Organization. */
  objectKeys(organizationId?: string): Promise<string[]>
}

/** Builds the app with a spy on `publish` that records and delivers each message. */
export async function createDocumentHarness(
  overrides: TestDepsOverrides = {}
): Promise<DocumentHarness> {
  const testApp = await createTestApp(overrides)
  const published: PlaybookEnvelope[] = []
  const original = testApp.deps.queue.publish.bind(testApp.deps.queue)
  const publishing: DocumentHarness['publishing'] = { delayMs: 0 }
  spyOn(testApp.deps.queue, 'publish').mockImplementation(async (envelope) => {
    const before = publishing.before
    publishing.before = undefined
    await before?.()
    if (publishing.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, publishing.delayMs))
    }
    published.push(envelope)
    await original(envelope)
  })
  const organizationId = newOrganizationId()
  const people = {
    owner: personIn(organizationId, 'owner'),
    admin: personIn(organizationId, 'admin'),
    manager: personIn(organizationId, 'manager'),
    rep: personIn(organizationId, 'rep'),
  } satisfies Record<Role, TestIdentity>

  const call: DocumentHarness['call'] = async (method, path, options = {}) => {
    const headers = options.headers ?? {}
    const auth = options.as === null ? {} : await testApp.bearer(options.as ?? people.owner)
    return testApp.app.request(path, { method, headers: { ...auth, ...headers } })
  }
  return {
    ...testApp,
    published,
    publishing,
    organizationId,
    people,
    call,
    async upload(name, bytes, options = {}) {
      const auth = await testApp.bearer(options.as ?? people.owner)
      return testApp.app.request(DOCUMENTS, {
        method: 'POST',
        body: uploadForm(name, bytes),
        headers: {
          ...auth,
          ...(options.key === undefined ? {} : { 'idempotency-key': options.key }),
          ...options.headers,
        },
      })
    },
    async objectKeys(of = organizationId) {
      const page = await testApp.deps.objects.list(of, {})
      return page.items.map((item) => item.key)
    },
  }
}

/** A fresh idempotency key. */
export function newKey(): string {
  return crypto.randomUUID()
}

/** A document id that nobody has. */
export function strangerDocumentId(): DocumentId {
  return formatId('doc', crypto.randomUUID())
}
