import { describe, expect, spyOn, test } from 'bun:test'
import {
  DOCUMENT_RETENTION_DAYS,
  documentSchema,
  listDocumentsResponseSchema,
  type PlaybookDocument,
} from 'tula-closeline-contract'
import {
  DOCUMENT_GET,
  DOCUMENT_INSERT,
  DOCUMENT_LIST_FILTERED,
  IDEMPOTENCY_BEGIN,
  QUOTA_LOCK,
} from 'tula-closeline-db'
import { StorageError } from 'tula-closeline-kit'
import { postgresError } from '~/adapters/memory/playbook-database'
import { newOrganizationId, type TestIdentity } from '~/testing'
import {
  createDocumentHarness,
  DOCUMENTS,
  type DocumentHarness,
  errorCode,
  newKey,
  pdfBytes,
  personIn,
  strangerDocumentId,
} from './test-support'
import { zipFixture } from './zip-fixture'

async function documentOf(response: Response): Promise<PlaybookDocument> {
  return documentSchema.parse(await response.json())
}

/** An upload whose body sends its first chunk and then waits; `abandon` ends it with an error. */
async function stalledUpload(h: DocumentHarness, as: TestIdentity) {
  const auth = await h.bearer(as)
  const boundary = 'stallboundary'
  const head = `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="a.pdf"\r\ncontent-type: application/pdf\r\n\r\n%PDF-1.7 partial`
  const pulled = Promise.withResolvers<void>()
  let open: ReadableStreamDefaultController<Uint8Array> | undefined
  let sent = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      open = controller
    },
    pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(new TextEncoder().encode(head))
        pulled.resolve()
      }
    },
  })
  const response = Promise.resolve(
    h.app.request(DOCUMENTS, {
      method: 'POST',
      body,
      duplex: 'half',
      headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
    } as RequestInit)
  )
  await pulled.promise
  return {
    response,
    abandon: () => open?.error(new Error('the sender went away')),
  }
}

describe('who may call', () => {
  test('a request with no token is refused before anything else happens', async () => {
    const h = await createDocumentHarness()
    const id = strangerDocumentId()

    for (const [method, path] of [
      ['POST', DOCUMENTS],
      ['GET', DOCUMENTS],
      ['GET', `${DOCUMENTS}/${id}`],
      ['DELETE', `${DOCUMENTS}/${id}`],
      ['POST', `${DOCUMENTS}/${id}/restore`],
    ] as const) {
      const response = await h.call(method, path, { as: null })
      expect(response.status).toBe(401)
    }
    expect(h.deps.database.transactions).toEqual([])
  })

  test.each(['manager', 'rep'] as const)(
    'a %s cannot write: upload, delete and restore are auth.forbidden and nothing is read or stored',
    async (role) => {
      const h = await createDocumentHarness()
      const id = strangerDocumentId()
      const as = h.people[role]

      const read = spyOn(Request.prototype, 'formData')
      const uploaded = await h.upload('a.pdf', pdfBytes('a'), { as })
      expect(read).not.toHaveBeenCalled()
      read.mockRestore()
      const deleted = await h.call('DELETE', `${DOCUMENTS}/${id}`, { as })
      const restored = await h.call('POST', `${DOCUMENTS}/${id}/restore`, { as })

      for (const response of [uploaded, deleted, restored]) {
        expect(response.status).toBe(403)
        expect(await errorCode(response)).toBe('auth.forbidden')
      }
      expect(h.deps.database.transactions).toEqual([])
      expect(await h.objectKeys()).toEqual([])
    }
  )

  test('the role is checked before the path is validated: a Rep with a malformed id gets auth.forbidden', async () => {
    const h = await createDocumentHarness()
    const as = h.people.rep

    const deleted = await h.call('DELETE', `${DOCUMENTS}/not-an-id`, { as })
    const restored = await h.call('POST', `${DOCUMENTS}/not-an-id/restore`, { as })
    const malformedAsOwner = await h.call('DELETE', `${DOCUMENTS}/not-an-id`)

    for (const response of [deleted, restored]) {
      expect(response.status).toBe(403)
      expect(await errorCode(response)).toBe('auth.forbidden')
    }
    expect(malformedAsOwner.status).toBe(400)
  })

  test.each(['owner', 'admin', 'manager', 'rep'] as const)(
    'a %s can list and read',
    async (role) => {
      const h = await createDocumentHarness()
      const created = await documentOf(await h.upload('a.pdf', pdfBytes('a')))

      const listed = await h.call('GET', DOCUMENTS, { as: h.people[role] })
      const read = await h.call('GET', `${DOCUMENTS}/${created.id}`, { as: h.people[role] })

      expect(listed.status).toBe(200)
      expect(listDocumentsResponseSchema.parse(await listed.json()).items.map((d) => d.id)).toEqual(
        [created.id]
      )
      expect(read.status).toBe(200)
    }
  )

  test('another Organization cannot list, read, delete or restore a document, and gets not_found, never 403', async () => {
    const h = await createDocumentHarness()
    const created = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    await h.call('DELETE', `${DOCUMENTS}/${created.id}`)
    const stranger = personIn(newOrganizationId(), 'owner')

    const listed = await h.call('GET', DOCUMENTS, { as: stranger })
    const read = await h.call('GET', `${DOCUMENTS}/${created.id}`, { as: stranger })
    const deleted = await h.call('DELETE', `${DOCUMENTS}/${created.id}`, { as: stranger })
    const restored = await h.call('POST', `${DOCUMENTS}/${created.id}/restore`, { as: stranger })

    expect(listDocumentsResponseSchema.parse(await listed.json()).items).toEqual([])
    for (const response of [read, deleted, restored]) {
      expect(response.status).toBe(404)
      expect(await errorCode(response)).toBe('document.not_found')
    }
    // The owner's document is as it was.
    const after = await documentOf(await h.call('GET', `${DOCUMENTS}/${created.id}`))
    expect(after.state).toBe('deleted')
  })

  test('the same content in two Organizations is two documents', async () => {
    const h = await createDocumentHarness()
    const other = personIn(newOrganizationId(), 'owner')

    const first = await h.upload('a.pdf', pdfBytes('same'))
    const second = await h.upload('a.pdf', pdfBytes('same'), { as: other })

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect((await documentOf(first)).id).not.toBe((await documentOf(second)).id)
  })
})

describe('upload: refused requests', () => {
  test('a file over the size limit is document.too_large (413) and is not stored', async () => {
    const h = await createDocumentHarness({ env: { MAX_UPLOAD_BYTES: '2000' } })

    const response = await h.upload('a.pdf', pdfBytes('big', 2001))

    expect(response.status).toBe(413)
    expect(await errorCode(response)).toBe('document.too_large')
    expect(await h.objectKeys()).toEqual([])
    expect(h.deps.database.transactions).toEqual([])
  })

  test('a file over the lowered size limit is refused before its bytes are copied out of the part', async () => {
    const h = await createDocumentHarness({ env: { MAX_UPLOAD_BYTES: '1000' } })
    const copy = spyOn(Blob.prototype, 'arrayBuffer')

    const response = await h.upload('a.pdf', pdfBytes('big', 2000))

    expect(response.status).toBe(413)
    expect(await errorCode(response)).toBe('document.too_large')
    expect(copy).not.toHaveBeenCalled()
    copy.mockRestore()
  })

  test('a body over the envelope limit is request.too_large, read no further than the limit', async () => {
    const h = await createDocumentHarness({ env: { MAX_UPLOAD_BYTES: '2000' } })
    const auth = await h.bearer(h.people.owner)
    const boundary = 'testboundary'
    const content = new TextDecoder().decode(pdfBytes('big', 100_000))
    const text = `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="a.pdf"\r\ncontent-type: application/pdf\r\n\r\n${content}\r\n--${boundary}--\r\n`
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(text)
        for (let at = 0; at < bytes.length; at += 8192) {
          controller.enqueue(bytes.subarray(at, at + 8192))
        }
        controller.close()
      },
    })

    // A body with no length, as a chunked upload is: the cap cuts it off while it is read.
    const response = await h.app.request(DOCUMENTS, {
      method: 'POST',
      body: stream,
      duplex: 'half',
      headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
    } as RequestInit)

    expect(response.status).toBe(413)
    expect(await errorCode(response)).toBe('request.too_large')
    expect(h.deps.database.transactions).toEqual([])
  })

  test('a declared length over the envelope limit is refused before the body is read', async () => {
    const h = await createDocumentHarness({ env: { MAX_UPLOAD_BYTES: '2000' } })
    const read = spyOn(Request.prototype, 'formData')

    const response = await h.upload('a.pdf', pdfBytes('a'), {
      headers: { 'content-length': '999999' },
    })

    expect(response.status).toBe(413)
    expect(await errorCode(response)).toBe('request.too_large')
    expect(read).not.toHaveBeenCalled()
    read.mockRestore()
  })

  test('an unauthenticated upload with no declared length is refused without its body being read', async () => {
    const h = await createDocumentHarness({ env: { MAX_UPLOAD_BYTES: '2000' } })
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(1024))
        if (pulls > 1000) {
          controller.close()
        }
      },
    })

    const response = await h.app.request(DOCUMENTS, {
      method: 'POST',
      body: stream,
      duplex: 'half',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
    } as RequestInit)

    expect(response.status).toBe(401)
    // The runtime may read a chunk or two ahead; it must not read the megabyte behind them.
    expect(pulls).toBeLessThan(10)
  })

  test('the upload limit is the upload route own: another route keeps the small one', async () => {
    const h = await createDocumentHarness({
      env: { MAX_UPLOAD_BYTES: '100000', MAX_REQUEST_BODY_BYTES: '1000' },
    })
    const auth = await h.bearer(h.people.owner)

    const upload = await h.upload('a.pdf', pdfBytes('mid', 5_000))
    const other = await h.app.request(`${DOCUMENTS}/${strangerDocumentId()}/restore`, {
      method: 'POST',
      body: 'x'.repeat(2_000),
      headers: { ...auth, 'content-length': '2000' },
    })

    expect(upload.status).toBe(201)
    expect(other.status).toBe(413)
    expect(await errorCode(other)).toBe('request.too_large')
  })

  test.each([
    ['an executable', 'tool.exe', pdfBytes('x')],
    ['a name with no extension', 'tool', pdfBytes('x')],
    ['a PDF that is not one inside', 'a.pdf', new TextEncoder().encode('just words')],
    ['a DOCX that is not a ZIP', 'a.docx', new TextEncoder().encode('PK not really')],
    [
      'a PPTX that holds a Word folder',
      'a.pptx',
      zipFixture([{ name: '[Content_Types].xml' }, { name: 'word/document.xml' }]),
    ],
    ['a text file with a NUL byte', 'a.txt', new Uint8Array([104, 105, 0, 33])],
    ['a text file that is not UTF-8', 'a.md', new Uint8Array([0xff, 0xfe, 0xfd])],
  ])('%s is document.unsupported_type (415) and nothing is stored', async (_label, name, bytes) => {
    const h = await createDocumentHarness()

    const response = await h.upload(name, bytes)

    expect(response.status).toBe(415)
    expect(await errorCode(response)).toBe('document.unsupported_type')
    expect(await h.objectKeys()).toEqual([])
    expect(h.deps.database.transactions).toEqual([])
  })

  test('an empty file and a name with a path separator are request.invalid', async () => {
    const h = await createDocumentHarness()

    for (const [name, bytes] of [
      ['empty.pdf', new Uint8Array()],
      ['a/b.pdf', pdfBytes('x')],
    ] as const) {
      const response = await h.upload(name, bytes)
      expect(response.status).toBe(400)
      expect(await errorCode(response)).toBe('request.invalid')
    }
  })

  test('a body that is not multipart is request.unsupported_media_type', async () => {
    const h = await createDocumentHarness()
    const auth = await h.bearer(h.people.owner)

    const response = await h.app.request(DOCUMENTS, {
      method: 'POST',
      body: JSON.stringify({ file: 'x' }),
      headers: { ...auth, 'content-type': 'application/json' },
    })

    expect(response.status).toBe(415)
    expect(await errorCode(response)).toBe('request.unsupported_media_type')
  })

  test('malformed multipart, a missing file part, a second part and a text part are request.invalid', async () => {
    const h = await createDocumentHarness()
    const auth = await h.bearer(h.people.owner)
    const withParts = (build: (form: FormData) => void) => {
      const form = new FormData()
      build(form)
      return h.app.request(DOCUMENTS, { method: 'POST', body: form, headers: auth })
    }

    const malformed = await h.app.request(DOCUMENTS, {
      method: 'POST',
      body: '--nope\r\nthis is not a part',
      headers: { ...auth, 'content-type': 'multipart/form-data; boundary=zzz' },
    })
    const missing = await withParts((form) => form.append('other', 'x'))
    const wrongName = await withParts((form) =>
      form.append('document', new File([pdfBytes('a')], 'a.pdf'))
    )
    const second = await withParts((form) => {
      form.append('file', new File([pdfBytes('a')], 'a.pdf'))
      form.append('file', new File([pdfBytes('b')], 'b.pdf'))
    })
    const extra = await withParts((form) => {
      form.append('file', new File([pdfBytes('a')], 'a.pdf'))
      form.append('note', 'hello')
    })
    const text = await withParts((form) => form.append('file', 'not a file'))

    for (const response of [malformed, missing, wrongName, second, extra, text]) {
      expect(response.status).toBe(400)
      expect(await errorCode(response)).toBe('request.invalid')
    }
    expect(await h.objectKeys()).toEqual([])
  })

  test('a malformed Idempotency-Key is request.invalid', async () => {
    const h = await createDocumentHarness()

    const response = await h.upload('a.pdf', pdfBytes('a'), { key: 'short' })

    expect(response.status).toBe(400)
  })
})

describe('upload: quota', () => {
  test('the document count is the limit, and a soft-deleted document still counts', async () => {
    const h = await createDocumentHarness({ env: { MAX_DOCUMENTS_PER_ORGANIZATION: '2' } })
    const first = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    await h.upload('b.pdf', pdfBytes('b'))

    const refused = await h.upload('c.pdf', pdfBytes('c'))
    await h.call('DELETE', `${DOCUMENTS}/${first.id}`)
    const stillRefused = await h.upload('c.pdf', pdfBytes('c'))

    for (const response of [refused, stillRefused]) {
      expect(response.status).toBe(409)
      expect(await errorCode(response)).toBe('document.quota_exceeded')
    }
    expect(await h.objectKeys()).toHaveLength(2)
  })

  test('the total size is the limit, counted with soft-deleted documents', async () => {
    const h = await createDocumentHarness({ env: { MAX_BYTES_PER_ORGANIZATION: '300' } })
    const big = pdfBytes('a', 150)
    const first = await documentOf(await h.upload('a.pdf', big))

    const refused = await h.upload('b.pdf', pdfBytes('b', 150))
    await h.call('DELETE', `${DOCUMENTS}/${first.id}`)
    const stillRefused = await h.upload('b.pdf', pdfBytes('b', 150))

    for (const response of [refused, stillRefused]) {
      expect(response.status).toBe(409)
      expect(await errorCode(response)).toBe('document.quota_exceeded')
    }
  })

  test('a duplicate is answered when the quota is full, because it adds nothing', async () => {
    const h = await createDocumentHarness({ env: { MAX_DOCUMENTS_PER_ORGANIZATION: '1' } })
    const first = await documentOf(await h.upload('a.pdf', pdfBytes('a')))

    const again = await h.upload('other-name.pdf', pdfBytes('a'))

    expect(again.status).toBe(200)
    expect((await documentOf(again)).id).toBe(first.id)
  })

  test('the quota of one Organization does not count another', async () => {
    const h = await createDocumentHarness({ env: { MAX_DOCUMENTS_PER_ORGANIZATION: '1' } })
    await h.upload('a.pdf', pdfBytes('a'))

    const other = await h.upload('b.pdf', pdfBytes('b'), {
      as: personIn(newOrganizationId(), 'owner'),
    })

    expect(other.status).toBe(201)
  })
})

describe('upload: a new document', () => {
  test('answers 201 with the document in state uploaded and the file name as stored', async () => {
    const h = await createDocumentHarness()

    const response = await h.upload('  Plan‮.pdf ', pdfBytes('a'))
    const created = await documentOf(response)

    expect(response.status).toBe(201)
    expect(created).toMatchObject({
      fileName: 'Plan.pdf',
      mediaType: 'application/pdf',
      state: 'uploaded',
      failureReason: null,
      pageCount: null,
      deletedAt: null,
      purgeAt: null,
      uploadedByUserId: h.people.owner.userId,
    })
    expect(created.sizeBytes).toBe(pdfBytes('a').byteLength)
  })

  test('stores the file under a key made from the document id, never the name, and queues ingestion', async () => {
    const h = await createDocumentHarness()

    const created = await documentOf(await h.upload('secret-name.pdf', pdfBytes('a')))

    const keys = await h.objectKeys()
    expect(keys).toEqual([`documents/${created.id}/original.pdf`])
    expect(keys.join()).not.toContain('secret-name')
    const stored = await h.deps.objects.get(h.organizationId, keys[0] ?? '')
    expect(stored?.body).toEqual(pdfBytes('a'))
    expect(h.deps.database.jobs(h.organizationId)).toMatchObject([
      { document_id: created.id, state: 'queued' },
    ])
    expect(h.published.map((m): unknown => [m.type, m.organizationId, m.payload])).toEqual([
      ['playbook.document_uploaded', h.organizationId, { documentId: created.id }],
    ])
  })

  test('a text file is accepted by its content, with the media type the service detected', async () => {
    const h = await createDocumentHarness()

    const response = await h.upload('notes.md', new TextEncoder().encode('# Notes\n\nhello'))

    expect(response.status).toBe(201)
    expect(await documentOf(response)).toMatchObject({ mediaType: 'text/markdown' })
  })

  test('never writes a file name, content or token to the log', async () => {
    const h = await createDocumentHarness()
    const auth = await h.bearer(h.people.owner)

    await h.upload('very-private-name.pdf', pdfBytes('very-private-content'))

    const logs = h.deps.logLines.join('\n')
    expect(logs).not.toContain('very-private-name')
    expect(logs).not.toContain('very-private-content')
    expect(logs).not.toContain(auth.authorization.slice(7))
  })
})

describe('upload: duplicates', () => {
  test('the same content again answers 200 with the stored document and its stored name, and stores nothing', async () => {
    const h = await createDocumentHarness()
    const first = await documentOf(await h.upload('first-name.pdf', pdfBytes('a')))

    const again = await h.upload('another-name.pdf', pdfBytes('a'))

    expect(again.status).toBe(200)
    const second = await documentOf(again)
    expect(second.id).toBe(first.id)
    expect(second.fileName).toBe('first-name.pdf')
    expect(await h.objectKeys()).toHaveLength(1)
    expect(h.deps.database.documents(h.organizationId)).toHaveLength(1)
    expect(h.published).toHaveLength(1)
  })

  test('a duplicate of a deleted document restores it to processing and queues it again', async () => {
    const h = await createDocumentHarness()
    const first = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    await h.call('DELETE', `${DOCUMENTS}/${first.id}`)
    h.published.length = 0

    const again = await h.upload('a.pdf', pdfBytes('a'))

    expect(again.status).toBe(200)
    expect(await documentOf(again)).toMatchObject({
      id: first.id,
      state: 'processing',
      purgeAt: null,
    })
    expect(h.published.map((m) => m.type)).toEqual(['playbook.document_uploaded'])
    expect(await h.objectKeys()).toHaveLength(1)
  })

  test('a duplicate of a deleted document past its purge time but not yet purged is restored too', async () => {
    const h = await createDocumentHarness()
    const first = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    await h.call('DELETE', `${DOCUMENTS}/${first.id}`)
    h.deps.clock.advance(`${DOCUMENT_RETENTION_DAYS + 1}d`)

    const again = await h.upload('a.pdf', pdfBytes('a'))

    expect(again.status).toBe(200)
    expect((await documentOf(again)).state).toBe('processing')
  })

  test('a duplicate of a failed document queues it again and answers state uploaded', async () => {
    const h = await createDocumentHarness()
    const first = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    h.deps.database.update(h.organizationId, first.id, {
      state: 'failed',
      failure_reason: 'unreadable',
    })
    h.published.length = 0

    const again = await h.upload('a.pdf', pdfBytes('a'))

    expect(again.status).toBe(200)
    expect(await documentOf(again)).toMatchObject({
      id: first.id,
      state: 'uploaded',
      failureReason: null,
    })
    expect(h.published.map((m) => m.type)).toEqual(['playbook.document_uploaded'])
  })

  test('content whose document is being purged is a new document', async () => {
    const h = await createDocumentHarness()
    const first = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    await h.call('DELETE', `${DOCUMENTS}/${first.id}`)
    h.deps.database.update(h.organizationId, first.id, { purge_started_at: Date.now() })

    const again = await h.upload('a.pdf', pdfBytes('a'))

    expect(again.status).toBe(201)
    expect((await documentOf(again)).id).not.toBe(first.id)
  })
})

describe('upload: idempotency key', () => {
  test('a replay returns the stored answer and does nothing again', async () => {
    const h = await createDocumentHarness()
    const key = newKey()
    const first = await h.upload('a.pdf', pdfBytes('a'), { key })
    const firstBody = await first.json()

    const replay = await h.upload('a.pdf', pdfBytes('a'), { key })

    expect(first.status).toBe(201)
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(firstBody)
    expect(h.deps.database.documents(h.organizationId)).toHaveLength(1)
    expect(await h.objectKeys()).toHaveLength(1)
    expect(h.published).toHaveLength(1)
  })

  test('the replay of a duplicate answer is that answer, 200', async () => {
    const h = await createDocumentHarness()
    await h.upload('a.pdf', pdfBytes('a'))
    const key = newKey()
    const first = await h.upload('a.pdf', pdfBytes('a'), { key })

    const replay = await h.upload('a.pdf', pdfBytes('a'), { key })

    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
  })

  test('the same key with another file is request.idempotency_key_reused (422) and stores nothing', async () => {
    const h = await createDocumentHarness()
    const key = newKey()
    await h.upload('a.pdf', pdfBytes('a'), { key })

    const response = await h.upload('b.pdf', pdfBytes('b'), { key })

    expect(response.status).toBe(422)
    expect(await errorCode(response)).toBe('request.idempotency_key_reused')
    expect(h.deps.database.documents(h.organizationId)).toHaveLength(1)
  })

  test('the same key with the same content under another name is also a different request', async () => {
    const h = await createDocumentHarness()
    const key = newKey()
    await h.upload('a.pdf', pdfBytes('a'), { key })

    const response = await h.upload('renamed.pdf', pdfBytes('a'), { key })

    expect(response.status).toBe(422)
  })

  test('a key another user used is not shared', async () => {
    const h = await createDocumentHarness()
    const key = newKey()
    await h.upload('a.pdf', pdfBytes('a'), { key })

    const response = await h.upload('b.pdf', pdfBytes('b'), { key, as: h.people.admin })

    expect(response.status).toBe(201)
  })

  test('a key held by a call in flight is request.idempotency_in_progress (409) with Retry-After', async () => {
    const h = await createDocumentHarness()
    h.deps.database.failNext(IDEMPOTENCY_BEGIN, postgresError('55P03'))

    const waited = await h.upload('a.pdf', pdfBytes('a'), { key: newKey() })

    expect(waited.status).toBe(409)
    expect(await errorCode(waited)).toBe('request.idempotency_in_progress')
    expect(waited.headers.get('retry-after')).toBe('1')
    expect(await h.objectKeys()).toEqual([])
  })

  test('a row in flight under the same request is also in progress', async () => {
    const h = await createDocumentHarness()
    const key = newKey()
    const { requestHashOf } = await import('./idempotency')
    h.deps.database.seedKeyInFlight({
      organization_id: h.organizationId,
      user_id: h.people.owner.userId,
      route: 'documents.upload',
      key,
      request_hash: requestHashOf('documents.upload', {
        fileName: 'a.pdf',
        contentHash: new Bun.CryptoHasher('sha256').update(pdfBytes('a')).digest('hex'),
      }).toString('hex'),
    })

    const response = await h.upload('a.pdf', pdfBytes('a'), { key })

    expect(response.status).toBe(409)
    expect(await errorCode(response)).toBe('request.idempotency_in_progress')
  })

  test('a failed attempt leaves no key behind, so the same key can be tried again', async () => {
    const h = await createDocumentHarness({ env: { MAX_DOCUMENTS_PER_ORGANIZATION: '1' } })
    await h.upload('first.pdf', pdfBytes('first'))
    const key = newKey()
    const refused = await h.upload('b.pdf', pdfBytes('b'), { key })

    expect(refused.status).toBe(409)
    expect(h.deps.database.keys(h.organizationId)).toEqual([])
  })
})

describe('upload: the concurrent upload bound', () => {
  test('an instance at its bound answers server.unavailable (503) with Retry-After without reading the body', async () => {
    const h = await createDocumentHarness({ env: { MAX_CONCURRENT_UPLOADS: '1' } })
    const release = Promise.withResolvers<void>()
    const reached = Promise.withResolvers<void>()
    const put = spyOn(h.deps.objects, 'put').mockImplementation(async () => {
      reached.resolve()
      await release.promise
    })
    const first = h.upload('a.pdf', pdfBytes('a'))
    await reached.promise
    const read = spyOn(Request.prototype, 'formData')

    const second = await h.upload('b.pdf', pdfBytes('b'))

    expect(second.status).toBe(503)
    expect(await errorCode(second)).toBe('server.unavailable')
    expect(second.headers.get('retry-after')).toBe('1')
    expect(read).not.toHaveBeenCalled()
    read.mockRestore()
    release.resolve()
    expect((await first).status).toBe(201)
    put.mockRestore()
    expect((await h.upload('c.pdf', pdfBytes('c'))).status).toBe(201)
  })

  test('a body that stalls after its first chunk is cut off with server.timeout (504) and gives its place back', async () => {
    const h = await createDocumentHarness({
      env: { MAX_CONCURRENT_UPLOADS: '1', UPLOAD_BODY_TIMEOUT_MS: '200' },
    })
    const stalled = await stalledUpload(h, h.people.owner)
    const startedAt = performance.now()

    const response = await stalled.response

    expect(response.status).toBe(504)
    expect(await errorCode(response)).toBe('server.timeout')
    expect(performance.now() - startedAt).toBeLessThan(2000)
    expect(await h.objectKeys()).toEqual([])
    expect(h.deps.database.transactions).toEqual([])
    expect((await h.upload('a.pdf', pdfBytes('a'))).status).toBe(201)
  })

  test('one Organization at its share is refused with rate.limited (429) while another is accepted', async () => {
    const h = await createDocumentHarness({
      env: { MAX_CONCURRENT_UPLOADS: '2', UPLOAD_BODY_TIMEOUT_MS: '60000' },
    })
    const stalled = await stalledUpload(h, h.people.owner)

    const same = await h.upload('b.pdf', pdfBytes('b'), { as: h.people.admin })
    const other = await h.upload('c.pdf', pdfBytes('c'), {
      as: personIn(newOrganizationId(), 'owner'),
    })

    expect(same.status).toBe(429)
    expect(await errorCode(same)).toBe('rate.limited')
    expect(same.headers.get('retry-after')).toBe('1')
    expect(other.status).toBe(201)
    stalled.abandon()
    await stalled.response
    expect((await h.upload('d.pdf', pdfBytes('d'), { as: h.people.admin })).status).toBe(201)
  })

  test('a failed upload gives its place back', async () => {
    const h = await createDocumentHarness({ env: { MAX_CONCURRENT_UPLOADS: '1' } })

    const bad = await h.upload('tool.exe', pdfBytes('a'))
    const good = await h.upload('a.pdf', pdfBytes('a'))

    expect(bad.status).toBe(415)
    expect(good.status).toBe(201)
  })

  test('a Manager does not take a place', async () => {
    const h = await createDocumentHarness({ env: { MAX_CONCURRENT_UPLOADS: '1' } })

    for (let i = 0; i < 3; i++) {
      expect((await h.upload('a.pdf', pdfBytes('a'), { as: h.people.manager })).status).toBe(403)
    }
    expect((await h.upload('a.pdf', pdfBytes('a'))).status).toBe(201)
  })
})

describe('upload: the order of the three effects and what each crash leaves', () => {
  test('a failed object write leaves nothing: no row, no message', async () => {
    const h = await createDocumentHarness()
    const put = spyOn(h.deps.objects, 'put').mockRejectedValue(new Error('disk gone'))

    const response = await h.upload('a.pdf', pdfBytes('a'))

    expect(response.status).toBe(500)
    expect(h.deps.database.documents(h.organizationId)).toEqual([])
    expect(h.published).toEqual([])
    put.mockRestore()
    expect((await h.upload('a.pdf', pdfBytes('a'))).status).toBe(201)
  })

  test('an unavailable object store is a retryable 503, with nothing left', async () => {
    const h = await createDocumentHarness()
    const put = spyOn(h.deps.objects, 'put').mockRejectedValue(
      new StorageError('storage.unavailable', 'try later')
    )

    const response = await h.upload('a.pdf', pdfBytes('a'))

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(h.deps.database.documents(h.organizationId)).toEqual([])
    put.mockRestore()
  })

  test('a failed insert after the object write removes the object: no row, no message, no file', async () => {
    const h = await createDocumentHarness()
    h.deps.database.failNext(DOCUMENT_INSERT, postgresError('XX000'))

    const response = await h.upload('a.pdf', pdfBytes('a'))

    expect(response.status).toBe(500)
    expect(await h.objectKeys()).toEqual([])
    expect(h.deps.database.documents(h.organizationId)).toEqual([])
    expect(h.deps.database.jobs(h.organizationId)).toEqual([])
    expect(h.published).toEqual([])
  })

  test('a failure raised by a statement, with or without a SQLSTATE, removes the object: the commit was never sent', async () => {
    for (const error of [postgresError('57P01'), new Error('connection reset by peer')]) {
      const h = await createDocumentHarness()
      h.deps.database.failNext(DOCUMENT_INSERT, error)

      const response = await h.upload('a.pdf', pdfBytes('a'))

      expect(response.status).toBe(500)
      expect(await h.objectKeys()).toEqual([])
      expect(h.deps.database.documents(h.organizationId)).toEqual([])
      expect(h.published).toEqual([])
    }
  })

  test('a commit that fails with an unknown outcome keeps the object, whether or not the row was applied', async () => {
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    for (const [error, applied] of [
      [postgresError('57P01'), true],
      [postgresError('57P01'), false],
      [epipe, true],
      [epipe, false],
      [postgresError('08006'), true],
    ] as const) {
      const h = await createDocumentHarness()
      h.deps.database.failNextCommit(error, { applied })

      const response = await h.upload('a.pdf', pdfBytes('a'))

      expect(response.status).toBe(500)
      expect(await h.objectKeys()).toHaveLength(1)
      expect(h.deps.database.documents(h.organizationId)).toHaveLength(applied ? 1 : 0)
      expect(h.deps.logLines.join('\n')).toContain('unknown outcome')
      if (applied) {
        const [row] = h.deps.database.documents(h.organizationId)
        expect(await h.objectKeys()).toEqual([row?.object_key ?? ''])
        const again = await h.upload('a.pdf', pdfBytes('a'))
        expect(again.status).toBe(200)
        expect(await h.objectKeys()).toEqual([row?.object_key ?? ''])
      }
    }
  })

  test('a commit refused with a serialization failure is a certain rollback and is run again', async () => {
    const h = await createDocumentHarness()
    h.deps.database.failNextCommit(postgresError('40001'), { applied: false })

    const response = await h.upload('a.pdf', pdfBytes('a'))

    expect(response.status).toBe(201)
    expect(await h.objectKeys()).toHaveLength(1)
    expect(h.deps.database.documents(h.organizationId)).toHaveLength(1)
  })

  test('a failed object write is logged as an unknown outcome with the document id and no file name', async () => {
    const h = await createDocumentHarness()
    const put = spyOn(h.deps.objects, 'put').mockRejectedValue(
      new StorageError('storage.unavailable', 'try later')
    )

    const response = await h.upload('secret-plan.pdf', pdfBytes('a'))

    expect(response.status).toBe(503)
    const log = h.deps.logLines.find((line) => line.includes('unknown outcome'))
    expect(log).toBeDefined()
    expect(log).toMatch(/doc_[0-9a-f]{32}/)
    expect(log).toContain(h.organizationId)
    expect(h.deps.logLines.join('\n')).not.toContain('secret-plan')
    put.mockRestore()
  })

  test('a failed publish after the commit still answers 201: the document is stored and its job is queued', async () => {
    const h = await createDocumentHarness()
    const publish = spyOn(h.deps.queue, 'publish').mockRejectedValue(new Error('queue down'))

    const response = await h.upload('a.pdf', pdfBytes('a'))

    expect(response.status).toBe(201)
    const created = await documentOf(response)
    expect(h.deps.database.documents(h.organizationId)).toMatchObject([
      { id: created.id, state: 'uploaded' },
    ])
    expect(h.deps.database.jobs(h.organizationId)).toMatchObject([
      { document_id: created.id, state: 'queued' },
    ])
    expect(await h.objectKeys()).toHaveLength(1)
    expect(h.deps.logLines.join('\n')).toContain('could not be published')
    publish.mockRestore()
  })

  test('a lock timeout on the Organization quota lock is a retryable 503, with nothing left', async () => {
    const h = await createDocumentHarness()
    h.deps.database.failNext(QUOTA_LOCK, postgresError('55P03'))

    const response = await h.upload('a.pdf', pdfBytes('a'))

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(await h.objectKeys()).toEqual([])
  })

  test('a deadlock is retried and the upload succeeds', async () => {
    const h = await createDocumentHarness()
    h.deps.database.failNext(QUOTA_LOCK, postgresError('40P01'))

    const response = await h.upload('a.pdf', pdfBytes('a'))

    expect(response.status).toBe(201)
    expect(h.deps.database.documents(h.organizationId)).toHaveLength(1)
  })

  test('the loser of a race between two new uploads of the same content removes its file', async () => {
    const h = await createDocumentHarness()
    const original = h.deps.objects.put.bind(h.deps.objects)
    const arrived = Promise.withResolvers<void>()
    let writing = 0
    const put = spyOn(h.deps.objects, 'put').mockImplementation(async (...args) => {
      writing++
      if (writing === 2) {
        arrived.resolve()
      }
      // Both uploads have found no document by now; neither commits until both have written.
      await arrived.promise
      await original(...args)
    })

    const [a, b] = await Promise.all([
      h.upload('a.pdf', pdfBytes('same')),
      h.upload('b.pdf', pdfBytes('same')),
    ])
    put.mockRestore()

    expect([a.status, b.status].sort()).toEqual([200, 201])
    expect(await h.objectKeys()).toHaveLength(1)
    expect(h.deps.database.documents(h.organizationId)).toHaveLength(1)
  })

  test('the loser of a race between two uploads with one key replays the winner and removes its file', async () => {
    const h = await createDocumentHarness()
    const original = h.deps.objects.put.bind(h.deps.objects)
    const arrived = Promise.withResolvers<void>()
    let writing = 0
    const put = spyOn(h.deps.objects, 'put').mockImplementation(async (...args) => {
      writing++
      if (writing === 2) {
        arrived.resolve()
      }
      await arrived.promise
      await original(...args)
    })
    const key = newKey()

    const [a, b] = await Promise.all([
      h.upload('a.pdf', pdfBytes('keyed-race'), { key }),
      h.upload('a.pdf', pdfBytes('keyed-race'), { key }),
    ])
    put.mockRestore()

    expect([a.status, b.status]).toEqual([201, 201])
    expect((await documentOf(a)).id).toBe((await documentOf(b)).id)
    expect(await h.objectKeys()).toHaveLength(1)
  })

  test('two uploads of the same content at once make one document', async () => {
    const h = await createDocumentHarness()

    const [a, b] = await Promise.all([
      h.upload('a.pdf', pdfBytes('same')),
      h.upload('b.pdf', pdfBytes('same')),
    ])

    expect([a.status, b.status].sort()).toEqual([200, 201])
    expect(h.deps.database.documents(h.organizationId)).toHaveLength(1)
    expect(await h.objectKeys()).toHaveLength(1)
  })
})

describe('list', () => {
  /** Seeds `count` ready documents that all share one creation time, so only the id orders them. */
  function seedTied(h: Awaited<ReturnType<typeof createDocumentHarness>>, count: number) {
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const id = `doc_${(i + 1).toString(16).padStart(32, '0')}`
      ids.push(id)
      h.deps.database.seed({ id, organization_id: h.organizationId, created_at: 1_700_000_000_000 })
    }
    return ids.sort().reverse()
  }

  async function pageOf(h: Awaited<ReturnType<typeof createDocumentHarness>>, query: string) {
    const response = await h.call('GET', `${DOCUMENTS}${query}`)
    expect(response.status).toBe(200)
    return listDocumentsResponseSchema.parse(await response.json())
  }

  test('pages across a boundary of documents created in the same instant, with none lost or repeated', async () => {
    const h = await createDocumentHarness()
    const expected = seedTied(h, 5)

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page = await pageOf(h, `?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`)
      seen.push(...page.items.map((d) => d.id))
      cursor = page.nextCursor
      pages++
    } while (cursor !== null && pages < 10)

    expect(seen).toEqual(expected)
    expect(pages).toBe(3)
  })

  test('the last page has no cursor when it is not full', async () => {
    const h = await createDocumentHarness()
    seedTied(h, 3)

    const first = await pageOf(h, '?limit=2')
    const second = await pageOf(h, `?limit=2&cursor=${first.nextCursor}`)

    expect(first.nextCursor).not.toBeNull()
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
  })

  test('lists newest first', async () => {
    const h = await createDocumentHarness()
    const older = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    h.deps.clock.advance('1h')
    const newer = await documentOf(await h.upload('b.pdf', pdfBytes('b')))

    const page = await pageOf(h, '')

    expect(page.items.map((d) => d.id)).toEqual([newer.id, older.id])
  })

  test('leaves out deleted documents unless state=deleted is asked for', async () => {
    const h = await createDocumentHarness()
    const kept = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    const gone = await documentOf(await h.upload('b.pdf', pdfBytes('b')))
    await h.call('DELETE', `${DOCUMENTS}/${gone.id}`)

    const live = await pageOf(h, '')
    const deleted = await pageOf(h, '?state=deleted')

    expect(live.items.map((d) => d.id)).toEqual([kept.id])
    expect(deleted.items).toMatchObject([{ id: gone.id, state: 'deleted' }])
    expect(deleted.items[0]?.purgeAt).not.toBeNull()
  })

  test('a list is one statement call, with no second read for any row', async () => {
    const h = await createDocumentHarness()
    seedTied(h, 5)
    const before = h.deps.database.statements.length

    await pageOf(h, '?limit=5')
    await pageOf(h, '?limit=5&state=failed')

    const ran = h.deps.database.statements.slice(before)
    expect(ran.filter((text) => text === DOCUMENT_LIST_FILTERED)).toHaveLength(2)
    expect(ran.filter((text) => text === DOCUMENT_GET)).toEqual([])
  })

  test.each(['uploaded', 'processing', 'ready', 'failed', 'deleted'] as const)(
    'state=%s lists only documents in that state',
    async (state) => {
      const h = await createDocumentHarness()
      for (const [i, each] of (
        ['uploaded', 'processing', 'ready', 'failed', 'deleted'] as const
      ).entries()) {
        h.deps.database.seed({
          id: `doc_${(i + 1).toString(16).padStart(32, '0')}`,
          organization_id: h.organizationId,
          state: each,
          ...(each === 'failed' ? { failure_reason: 'no_text' } : {}),
          ...(each === 'deleted'
            ? { deleted_at: Date.now(), purge_due_at: Date.now() + 86_400_000, deletion_seq: 1 }
            : {}),
        })
      }

      const page = await pageOf(h, `?state=${state}`)

      expect(page.items.map((d) => d.state)).toEqual([state])
    }
  )

  test('with no filter, every state but deleted is listed', async () => {
    const h = await createDocumentHarness()
    for (const [i, each] of (['uploaded', 'processing', 'ready', 'deleted'] as const).entries()) {
      h.deps.database.seed({
        id: `doc_${(i + 1).toString(16).padStart(32, '0')}`,
        organization_id: h.organizationId,
        state: each,
        ...(each === 'deleted'
          ? { deleted_at: Date.now(), purge_due_at: Date.now() + 86_400_000, deletion_seq: 1 }
          : {}),
      })
    }

    const page = await pageOf(h, '')

    expect(page.items.map((d) => d.state).sort()).toEqual(['processing', 'ready', 'uploaded'])
  })

  test('a filtered list pages across documents created in the same instant, with none lost or repeated', async () => {
    const h = await createDocumentHarness()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const id = `doc_${(i + 1).toString(16).padStart(32, '0')}`
      ids.push(id)
      h.deps.database.seed({
        id,
        organization_id: h.organizationId,
        state: 'failed',
        failure_reason: 'no_text',
        created_at: 1_700_000_000_000,
      })
      // A ready document in the same instant must not take a place in the failed list.
      h.deps.database.seed({
        id: `doc_${(i + 100).toString(16).padStart(32, '0')}`,
        organization_id: h.organizationId,
        created_at: 1_700_000_000_000,
      })
    }

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page = await pageOf(
        h,
        `?state=failed&limit=2${cursor === null ? '' : `&cursor=${cursor}`}`
      )
      seen.push(...page.items.map((d) => d.id))
      cursor = page.nextCursor
      pages++
    } while (cursor !== null && pages < 10)

    expect(seen).toEqual([...ids].sort().reverse())
    expect(pages).toBe(3)
  })

  test('returns the page count when the ingestion job has recorded one, and null before', async () => {
    const h = await createDocumentHarness()
    const created = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    const [row] = h.deps.database.documents(h.organizationId)

    const before = await h.call('GET', `${DOCUMENTS}/${created.id}`)
    h.deps.database.update(h.organizationId, created.id, { page_count: 7 })
    const read = await h.call('GET', `${DOCUMENTS}/${created.id}`)
    const listed = await pageOf(h, '')

    expect(row?.page_count).toBeNull()
    expect((await documentOf(before)).pageCount).toBeNull()
    expect((await documentOf(read)).pageCount).toBe(7)
    expect(listed.items[0]?.pageCount).toBe(7)
  })

  test('a listed document carries its updated time without a second read', async () => {
    const h = await createDocumentHarness()
    const created = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    h.deps.database.update(h.organizationId, created.id, {
      state: 'ready',
      updated_at: Date.parse('2030-01-02T03:04:05.000Z'),
    })

    const page = await pageOf(h, '')

    expect(page.items[0]?.updatedAt).toBe('2030-01-02T03:04:05.000Z')
  })

  test.each([
    ['a cursor that is not ours', '?cursor=bm90LWpzb24'],
    ['a limit over 100', '?limit=101'],
    ['a limit of 0', '?limit=0'],
    ['an unknown state', '?state=archived'],
    ['an unknown parameter', '?sort=name'],
  ])('%s is request.invalid', async (_label, query) => {
    const h = await createDocumentHarness()

    const response = await h.call('GET', `${DOCUMENTS}${query}`)

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('request.invalid')
  })

  test('a cursor with a timestamp the database would refuse is request.invalid, not a server error', async () => {
    const h = await createDocumentHarness()
    const cursor = btoa(JSON.stringify({ t: '2026-13-45 99:99:99+00', i: `doc_${'0'.repeat(32)}` }))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')

    const response = await h.call('GET', `${DOCUMENTS}?cursor=${cursor}`)

    expect(response.status).toBe(400)
  })
})

describe('read', () => {
  test('returns the document in the contract shape', async () => {
    const h = await createDocumentHarness()
    const created = await documentOf(await h.upload('a.pdf', pdfBytes('a')))

    const response = await h.call('GET', `${DOCUMENTS}/${created.id}`)

    expect(response.status).toBe(200)
    expect(await documentOf(response)).toEqual(created)
  })

  test('an unknown id is document.not_found and a malformed one is request.invalid', async () => {
    const h = await createDocumentHarness()

    const unknown = await h.call('GET', `${DOCUMENTS}/${strangerDocumentId()}`)
    const malformed = await h.call('GET', `${DOCUMENTS}/not-an-id`)

    expect(unknown.status).toBe(404)
    expect(await errorCode(unknown)).toBe('document.not_found')
    expect(malformed.status).toBe(400)
  })

  test('a failed document carries its reason and a deleted one its purge time', async () => {
    const h = await createDocumentHarness()
    const failed = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    h.deps.database.update(h.organizationId, failed.id, {
      state: 'failed',
      failure_reason: 'too_many_pages',
    })
    const deleted = await documentOf(await h.upload('b.pdf', pdfBytes('b')))
    await h.call('DELETE', `${DOCUMENTS}/${deleted.id}`)

    const f = await documentOf(await h.call('GET', `${DOCUMENTS}/${failed.id}`))
    const d = await documentOf(await h.call('GET', `${DOCUMENTS}/${deleted.id}`))

    expect(f).toMatchObject({ state: 'failed', failureReason: 'too_many_pages' })
    expect(d.state).toBe('deleted')
    expect(new Date(d.purgeAt ?? '').getTime() - new Date(d.deletedAt ?? '').getTime()).toBe(
      DOCUMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000
    )
  })
})

describe('delete', () => {
  test('hides the document, sets its purge time and queues the cleanup with the deletion sequence', async () => {
    const h = await createDocumentHarness()
    const created = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    h.published.length = 0

    const response = await h.call('DELETE', `${DOCUMENTS}/${created.id}`)

    expect(response.status).toBe(200)
    expect(await documentOf(response)).toMatchObject({ id: created.id, state: 'deleted' })
    expect(h.published.map((m): unknown => [m.type, m.payload])).toEqual([
      ['playbook.document_deleted', { documentId: created.id, deletionSeq: 1 }],
    ])
    expect(h.deps.database.jobs(h.organizationId)).toMatchObject([{ state: 'cancelled' }])
  })

  test('deleting twice answers the same and publishes once', async () => {
    const h = await createDocumentHarness()
    const created = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    h.published.length = 0

    const first = await h.call('DELETE', `${DOCUMENTS}/${created.id}`)
    const second = await h.call('DELETE', `${DOCUMENTS}/${created.id}`)

    expect(second.status).toBe(200)
    expect(await second.json()).toEqual(await first.json())
    expect(h.published).toHaveLength(1)
  })

  test('delete, restore, delete again publishes the second sequence', async () => {
    const h = await createDocumentHarness()
    const created = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    await h.call('DELETE', `${DOCUMENTS}/${created.id}`)
    await h.call('POST', `${DOCUMENTS}/${created.id}/restore`)
    h.published.length = 0

    await h.call('DELETE', `${DOCUMENTS}/${created.id}`)

    expect(h.published.map((m): unknown => m.payload)).toEqual([
      { documentId: created.id, deletionSeq: 2 },
    ])
  })

  test('an unknown document is document.not_found and publishes nothing', async () => {
    const h = await createDocumentHarness()

    const response = await h.call('DELETE', `${DOCUMENTS}/${strangerDocumentId()}`)

    expect(response.status).toBe(404)
    expect(await errorCode(response)).toBe('document.not_found')
    expect(h.published).toEqual([])
  })

  test('a failed cleanup publish still answers 200: the sweep finds the document', async () => {
    const h = await createDocumentHarness()
    const created = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    const publish = spyOn(h.deps.queue, 'publish').mockRejectedValue(new Error('queue down'))

    const response = await h.call('DELETE', `${DOCUMENTS}/${created.id}`)

    expect(response.status).toBe(200)
    expect((await documentOf(response)).state).toBe('deleted')
    publish.mockRestore()
  })
})

describe('restore', () => {
  test('brings a deleted document back to processing and queues it again', async () => {
    const h = await createDocumentHarness()
    const created = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    await h.call('DELETE', `${DOCUMENTS}/${created.id}`)
    h.published.length = 0

    const response = await h.call('POST', `${DOCUMENTS}/${created.id}/restore`)

    expect(response.status).toBe(200)
    expect(await documentOf(response)).toMatchObject({
      id: created.id,
      state: 'processing',
      deletedAt: null,
      purgeAt: null,
    })
    expect(h.published.map((m): unknown => [m.type, m.payload])).toEqual([
      ['playbook.document_uploaded', { documentId: created.id }],
    ])
  })

  test('a second restore answers 200 with the document as it is and publishes nothing', async () => {
    const h = await createDocumentHarness()
    const created = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    await h.call('DELETE', `${DOCUMENTS}/${created.id}`)
    await h.call('POST', `${DOCUMENTS}/${created.id}/restore`)
    h.published.length = 0

    const response = await h.call('POST', `${DOCUMENTS}/${created.id}/restore`)

    expect(response.status).toBe(200)
    expect((await documentOf(response)).state).toBe('processing')
    expect(h.published).toEqual([])
  })

  test('a document that was never deleted is answered as it is', async () => {
    const h = await createDocumentHarness()
    const created = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    h.published.length = 0

    const response = await h.call('POST', `${DOCUMENTS}/${created.id}/restore`)

    expect(response.status).toBe(200)
    expect((await documentOf(response)).state).toBe('uploaded')
    expect(h.published).toEqual([])
  })

  test('after the purge time it is document.not_restorable (410), by the database clock', async () => {
    const h = await createDocumentHarness()
    const created = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    await h.call('DELETE', `${DOCUMENTS}/${created.id}`)
    h.deps.clock.advance(`${DOCUMENT_RETENTION_DAYS}d`)
    h.published.length = 0

    const response = await h.call('POST', `${DOCUMENTS}/${created.id}/restore`)

    expect(response.status).toBe(410)
    expect(await errorCode(response)).toBe('document.not_restorable')
    expect(h.published).toEqual([])
  })

  test('just before the purge time it still restores', async () => {
    const h = await createDocumentHarness()
    const created = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    await h.call('DELETE', `${DOCUMENTS}/${created.id}`)
    h.deps.clock.advance(`${DOCUMENT_RETENTION_DAYS * 24 - 1}h`)

    const response = await h.call('POST', `${DOCUMENTS}/${created.id}/restore`)

    expect(response.status).toBe(200)
  })

  test('a document whose purge has started is not restorable even before its time', async () => {
    const h = await createDocumentHarness()
    const created = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    await h.call('DELETE', `${DOCUMENTS}/${created.id}`)
    h.deps.database.update(h.organizationId, created.id, { purge_started_at: Date.now() })

    const response = await h.call('POST', `${DOCUMENTS}/${created.id}/restore`)

    expect(response.status).toBe(410)
  })

  test('an unknown id, and a purged one, are document.not_found (404)', async () => {
    const h = await createDocumentHarness()
    const created = await documentOf(await h.upload('a.pdf', pdfBytes('a')))
    await h.call('DELETE', `${DOCUMENTS}/${created.id}`)
    h.deps.database.purgeAll(h.organizationId)

    const unknown = await h.call('POST', `${DOCUMENTS}/${strangerDocumentId()}/restore`)
    const purged = await h.call('POST', `${DOCUMENTS}/${created.id}/restore`)

    for (const response of [unknown, purged]) {
      expect(response.status).toBe(404)
      expect(await errorCode(response)).toBe('document.not_found')
    }
  })
})

describe('OpenAPI', () => {
  test('describes every document route from the contract, with the roles and the codes', async () => {
    const h = await createDocumentHarness()

    const document = (await (await h.app.request('/openapi.json')).json()) as {
      paths: Record<
        string,
        Record<
          string,
          { description?: string; responses: Record<string, unknown>; security?: unknown[] }
        >
      >
    }

    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/v1/playbook/documents',
        '/v1/playbook/documents/{documentId}',
        '/v1/playbook/documents/{documentId}/restore',
        '/internal/playbook/organizations/{organizationId}/remove-all',
      ])
    )
    const upload = document.paths['/v1/playbook/documents']?.post
    expect(upload?.description).toContain('multipart/form-data')
    expect(Object.keys(upload?.responses ?? {})).toEqual(
      expect.arrayContaining([
        '200',
        '201',
        '400',
        '401',
        '403',
        '409',
        '413',
        '415',
        '422',
        '500',
        '503',
      ])
    )
    expect(upload?.security).toEqual([{ accessToken: [] }])
    const removeAll =
      document.paths['/internal/playbook/organizations/{organizationId}/remove-all']?.post
    expect(removeAll?.security).toEqual([{ internalSecret: [] }])
  })
})
