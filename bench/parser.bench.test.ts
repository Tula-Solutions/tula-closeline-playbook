import { expect, test } from 'bun:test'
import { createDocumentParser } from '../src/adapters/parser'
import { extractDocument } from '../src/adapters/parser/extract'
import { buildDocx, buildPdf, buildPptx, buildZip } from '../src/adapters/parser/test-support'
import { ParseError } from '../src/ports/parser'
import { measure, summary } from './measure'

// The parsers on a 300-page document of each type, in the calling thread (the worker adds one
// thread start per document, measured separately below). Complexity is O(file size) in time and
// O(file size + extracted text) in memory for TXT, MD, DOCX and PPTX: one pass to inflate, one
// scan of the XML, one pass to cut pages. A PDF is O(pages + content) through pdf.js, with the
// page count checked before any page is read. Budgets are about 5x the best batch measured
// locally, rounded up, because shared runners have measured the chunker at twice its local time.
const limits = { maxPages: 300, maxTextChars: 5_000_000 }
const sentence = 'Pricing is agreed per seat. Discounts apply after review. '
const paragraph = sentence.repeat(6)

const documents = {
  txt: new TextEncoder().encode(`${paragraph}\n\n`.repeat(11_000)),
  md: new TextEncoder().encode(`# Heading\n\n${paragraph}\n\n`.repeat(11_000)),
  docx: buildDocx(
    Array.from({ length: 3_000 }, (_v, i) => `${paragraph} ${i}`),
    { pageBreakEvery: 10 }
  ),
  pptx: buildPptx(Array.from({ length: 300 }, (_v, i) => [paragraph, `Slide ${i}`])),
  pdf: buildPdf({ pages: Array.from({ length: 300 }, (_v, i) => `${sentence} ${i}`) }),
} as const

const mediaTypes = {
  txt: 'text/plain',
  md: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
} as const

// Typical best batch of 3 documents, locally: TXT and MD 21 ms, DOCX 15 ms, PPTX 9 ms, PDF 73 ms.
// A budget is 5 to 7 times that, which a shared runner at twice the local time stays well under.
const BUDGET_MS = { txt: 150, md: 150, docx: 100, pptx: 80, pdf: 500 } as const

test.each(Object.keys(documents) as (keyof typeof documents)[])(
  'parser %s: the best of batches of 3 documents of about 300 pages is within budget',
  async (type) => {
    let pages = 0
    const result = await measure(
      async () => {
        pages = (await extractDocument(documents[type], mediaTypes[type], limits)).pages.length
      },
      { warmup: 1, batchRequests: 3, batches: 4 }
    )

    console.log(summary(`parser ${type}`, result))
    expect(pages).toBeGreaterThanOrEqual(100)
    expect(result.bestMs).toBeLessThan(BUDGET_MS[type])
  },
  120_000
)

test('parser through the worker: the thread start adds little to a small document', async () => {
  const parser = createDocumentParser({
    limits,
    timeoutMs: 30_000,
    memoryLimitBytes: 2 ** 31,
  })
  const small = buildDocx(['one', 'two'])
  const result = await measure(
    () =>
      parser.parse(
        { bytes: small, mediaType: mediaTypes.docx },
        { signal: new AbortController().signal }
      ),
    { warmup: 3, batchRequests: 10, batches: 4 }
  )

  console.log(summary('parser worker start', result))
  expect(result.bestMs).toBeLessThan(1_000)
}, 120_000)

// Hostile shapes. Each must end fast with a refusal, not by working through its size.
const MiB = 1024 * 1024
// The inputs are built here, outside the timed part: the cost under test is the parser's.
const bombZip = buildZip([{ name: 'word/document.xml', data: new Uint8Array(200 * MiB) }])
const bigText = new TextEncoder().encode('word '.repeat(5_300_000))
const deepPdf = buildPdf({ pages: ['deep'], nestedDepth: 10_000 })
const wideTreePdf = buildPdf({ pages: Array.from({ length: 5_000 }, () => 'x') })
const deepXml = buildZip([
  {
    name: 'word/document.xml',
    data: `<w:document>${'<w:x>'.repeat(10_000)}${'</w:x>'.repeat(10_000)}</w:document>`,
  },
])
// Typical locally: bomb 0.1 ms, 25 MB text 3 ms, deep page tree 31 ms, 5 000 pages 25 ms, deep XML 0.3 ms.
const hostile: [string, () => Promise<unknown>, number][] = [
  ['a zip bomb of 200 MiB of zeros', () => extractDocument(bombZip, mediaTypes.docx, limits), 500],
  ['a 25 MB text file', () => extractDocument(bigText, 'text/plain', limits), 500],
  [
    'a PDF with a page tree nested 10 000 deep',
    () => extractDocument(deepPdf, 'application/pdf', limits),
    2_000,
  ],
  ['a PDF with 5 000 pages', () => extractDocument(wideTreePdf, 'application/pdf', limits), 2_000],
  ['XML nested 10 000 deep', () => extractDocument(deepXml, mediaTypes.docx, limits), 500],
]

test.each(hostile)(
  'parser, hostile input (%s): refused or parsed within budget',
  async (_name, run, budget) => {
    const started = performance.now()
    await run().then(
      () => undefined,
      (error: unknown) => {
        expect(error).toBeInstanceOf(ParseError)
      }
    )
    const elapsed = performance.now() - started
    console.log(`parser hostile: ${_name} took ${elapsed.toFixed(1)} ms`)
    expect(elapsed).toBeLessThan(budget)
  },
  60_000
)
