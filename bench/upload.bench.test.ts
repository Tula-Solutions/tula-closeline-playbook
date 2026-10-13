import { expect, test } from 'bun:test'
import { checkUploadFile, MAX_DOCUMENT_BYTES } from 'tula-closeline-contract'
import { detectDocumentType } from '../src/modules/document/detect'
import { sha256 } from '../src/modules/document/service'
import { measure, summary } from './measure'

// The CPU-bound part of an upload: the file check, the content check and the SHA-256 of a file of
// the largest size (25 MiB), as the upload service runs them. Complexity is O(file size) with no
// copy of the file: `detectDocumentType` and the hash read the bytes in place, and the hash yields
// to the event loop between 4 MiB slices. The multipart parse, the object write and the database
// are not here: the first two are the runtime's and the network's, the third is one transaction of
// a handful of indexed statements that only the integration suite can show.
// A PDF is the worst case for the content check (it looks at 1 KiB); a DOCX scans the whole file.
// Typical best batch: 141 ms for 10 uploads (about 14 ms each). Budget: 5x, rounded up.
const BUDGET_MS = 700
const BATCH = 10

const file = new Uint8Array(MAX_DOCUMENT_BYTES)
file.set(new TextEncoder().encode('PK\u0003\u0004word/document.xml'))
for (let offset = 64; offset < file.length; offset += 4096) {
  file[offset] = offset % 251
}

test(`upload check and hash: the best of 5 batches of ${BATCH} files of 25 MiB is within ${BUDGET_MS} ms`, async () => {
  let accepted = 0
  const result = await measure(
    async () => {
      const checked = checkUploadFile({
        fileName: 'plan.docx',
        declaredMediaType: 'application/octet-stream',
        sizeBytes: file.byteLength,
      })
      if (checked.ok && detectDocumentType(file, checked.file.fileName) === 'docx') {
        accepted += (await sha256(file)).byteLength
      }
    },
    { warmup: 3, batchRequests: BATCH, batches: 5 }
  )

  console.log(summary('upload check and hash', result))
  expect(accepted).toBeGreaterThan(0)
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
})
