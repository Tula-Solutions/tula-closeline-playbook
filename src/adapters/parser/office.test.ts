import { describe, expect, test } from 'bun:test'
import { deflateRawSync } from 'node:zlib'
import { ParseError } from '~/ports/parser'
import { parseDocx } from './docx'
import { parsePptx } from './pptx'
import { buildDocx, buildPptx, buildZip, concat } from './test-support'
import { scanXml, XML_MAX_DEPTH } from './xml'

const limits = { maxPages: 300, maxTextChars: 5_000_000 }
const encoder = new TextEncoder()
const WORD = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const CT = '<Types/>'

/** The reason a parse failed with, or `undefined` when it did not fail. */
function reasonOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof ParseError ? error.reason : `other: ${String(error)}`
  }
  return undefined
}

const docxWith = (body: string, extra: { name: string; data: string | Uint8Array }[] = []) =>
  buildZip([
    { name: '[Content_Types].xml', data: CT },
    {
      name: 'word/document.xml',
      data: `<w:document ${WORD}><w:body>${body}</w:body></w:document>`,
    },
    ...extra,
  ])

describe('parseDocx', () => {
  test('paragraphs become lines of one page', () => {
    const { pages } = parseDocx(buildDocx(['First', 'Second & <third>']), limits)
    expect(pages).toEqual([{ number: 1, text: 'First\nSecond & <third>\n', needsOcr: false }])
  })

  test('explicit and rendered page breaks end a page, and a doubled break makes no empty page', () => {
    const body =
      '<w:p><w:r><w:t>one</w:t></w:r></w:p>' +
      '<w:p><w:r><w:lastRenderedPageBreak/><w:br w:type="page"/><w:t>two</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>three</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:pageBreakBefore w:val="0"/></w:pPr><w:r><w:t>still three</w:t></w:r></w:p>'
    const { pages } = parseDocx(docxWith(body), limits)
    expect(pages.map((p) => p.text.trim())).toEqual(['one', 'two', 'three\nstill three'])
  })

  test('tabs and line breaks are kept; deleted text, field code and alternate content are not read twice', () => {
    const body =
      '<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r>' +
      '<w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:r><w:instrText>HYPERLINK</w:instrText></w:r></w:p>' +
      '<mc:AlternateContent><mc:Choice><w:p><w:r><w:t>shown</w:t></w:r></w:p></mc:Choice>' +
      '<mc:Fallback><w:p><w:r><w:t>duplicate</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>'
    expect(parseDocx(docxWith(body), limits).pages[0]?.text).toBe('a\tb\nc\nshown\n')
  })

  test('a long page without breaks is cut by the fixed page size', () => {
    const paragraphs = Array.from({ length: 100 }, () => 'x'.repeat(900))
    expect(parseDocx(buildDocx(paragraphs), limits).pages.length).toBeGreaterThan(3)
  })

  test('the page limit and the text limit apply', () => {
    const many = buildDocx(
      Array.from({ length: 10 }, (_v, i) => `p${i}`),
      { pageBreakEvery: 1 }
    )
    expect(reasonOf(() => parseDocx(many, { ...limits, maxPages: 5 }))).toBe('too_many_pages')
    expect(
      reasonOf(() => parseDocx(buildDocx(['x'.repeat(500)]), { ...limits, maxTextChars: 100 }))
    ).toBe('processing_failed')
  })

  test('a document with no text is one empty page', () => {
    expect(parseDocx(docxWith(''), limits).pages).toEqual([
      { number: 1, text: '', needsOcr: false },
    ])
  })

  test('a zip with no word/document.xml, or not a zip, is unreadable', () => {
    expect(reasonOf(() => parseDocx(buildZip([{ name: 'a.txt', data: 'x' }]), limits))).toBe(
      'unreadable'
    )
    expect(reasonOf(() => parseDocx(encoder.encode('plain text, not a zip at all'), limits))).toBe(
      'unreadable'
    )
  })

  test('macros and embedded objects are never opened, only named', () => {
    const bytes = docxWith('<w:p><w:r><w:t>body</w:t></w:r></w:p>', [
      { name: 'word/vbaProject.bin', data: 'SECRET-MACRO' },
      { name: 'word/embeddings/oleObject1.bin', data: 'SECRET-OLE' },
    ])
    const text = JSON.stringify(parseDocx(bytes, limits))
    expect(text).toContain('body')
    expect(text).not.toContain('SECRET')
  })

  test('a password-protected Office file (the compound file container) is password_protected', () => {
    const cfb = new Uint8Array([
      0xd0,
      0xcf,
      0x11,
      0xe0,
      0xa1,
      0xb1,
      0x1a,
      0xe1,
      ...new Array(600).fill(0),
    ])
    expect(reasonOf(() => parseDocx(cfb, limits))).toBe('password_protected')
  })

  test('an encrypted zip entry is password_protected', () => {
    const bytes = docxWith('<w:p/>')
    const view = new DataView(bytes.buffer)
    // Set bit 0 of the general purpose flag of the central directory entry of word/document.xml.
    for (let at = 0; at < bytes.length - 4; at++) {
      if (view.getUint32(at, true) === 0x02014b50) {
        const nameLength = view.getUint16(at + 28, true)
        const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength))
        if (name === 'word/document.xml') {
          view.setUint16(at + 8, 1, true)
        }
      }
    }
    expect(reasonOf(() => parseDocx(bytes, limits))).toBe('password_protected')
  })
})

describe('parsePptx', () => {
  test('one page per slide, from every text paragraph', () => {
    const { pages } = parsePptx(buildPptx([['Title', 'Body'], ['Second']]), limits)
    expect(pages.map((p) => p.text)).toEqual(['Title\nBody\n', 'Second\n'])
  })

  test('slides follow the presentation order, not the file names', () => {
    const slide = (text: string) =>
      `<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`
    const bytes = buildZip([
      { name: '[Content_Types].xml', data: CT },
      {
        name: 'ppt/presentation.xml',
        data: '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="1" r:id="rId9"/><p:sldId id="2" r:id="rId8"/></p:sldIdLst></p:presentation>',
      },
      {
        name: 'ppt/_rels/presentation.xml.rels',
        data: '<Relationships><Relationship Id="rId8" Target="slides/slide1.xml"/><Relationship Id="rId9" Target="slides/slide2.xml"/></Relationships>',
      },
      { name: 'ppt/slides/slide1.xml', data: slide('file one') },
      { name: 'ppt/slides/slide2.xml', data: slide('file two') },
    ])
    expect(parsePptx(bytes, limits).pages.map((p) => p.text.trim())).toEqual([
      'file two',
      'file one',
    ])
  })

  test('slide files in numeric order when there is no presentation part', () => {
    const slides = Array.from({ length: 12 }, (_v, i) => [`s${i + 1}`])
    expect(parsePptx(buildPptx(slides), limits).pages.map((p) => p.text.trim())).toEqual(
      slides.map((s) => String(s[0]))
    )
  })

  test('more slides than the page limit is too_many_pages before any slide is inflated', () => {
    // Every slide part is corrupt: reading one would be `unreadable`, so the answer proves none was read.
    const members = Array.from({ length: 301 }, (_v, i) => ({
      name: `ppt/slides/slide${i + 1}.xml`,
      data: 'not xml <<<',
    }))
    const bytes = buildZip([{ name: '[Content_Types].xml', data: CT }, ...members])
    const error = (() => {
      try {
        parsePptx(bytes, limits)
      } catch (thrown) {
        return thrown
      }
    })()
    expect(error).toBeInstanceOf(ParseError)
    expect((error as ParseError).reason).toBe('too_many_pages')
    expect((error as ParseError).pageCount).toBe(301)
  })

  test('an archive with no slide is unreadable', () => {
    expect(
      reasonOf(() => parsePptx(buildZip([{ name: '[Content_Types].xml', data: CT }]), limits))
    ).toBe('unreadable')
  })
})

describe('hostile archives', () => {
  test('a zip bomb is refused from its directory, before inflating, as processing_failed', () => {
    const bomb = docxWith('', [{ name: 'word/bomb.xml', data: new Uint8Array(200 * 1024 * 1024) }])
    const started = performance.now()
    expect(reasonOf(() => parseDocx(bomb, limits))).toBe('processing_failed')
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  test('an entry whose header lies about its size is unreadable, and inflation stops at the declared size', () => {
    const raw = new Uint8Array(50 * 1024 * 1024)
    const bytes = buildZip([
      { name: '[Content_Types].xml', data: CT },
      { name: 'word/document.xml', data: raw },
    ])
    const view = new DataView(bytes.buffer)
    for (let at = 0; at < bytes.length - 4; at++) {
      if (view.getUint32(at, true) === 0x02014b50) {
        view.setUint32(at + 24, 1000, true)
      }
    }
    const started = performance.now()
    expect(reasonOf(() => parseDocx(bytes, limits))).toBe('unreadable')
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  test('more entries than the limit is processing_failed', () => {
    const members = Array.from({ length: 5_001 }, (_v, i) => ({
      name: `f${i}`,
      data: '',
      stored: true,
    }))
    expect(reasonOf(() => parseDocx(buildZip(members), limits))).toBe('processing_failed')
  })

  test('total uncompressed size over the limit is processing_failed even when no entry is large', () => {
    const noise = new Uint8Array(30 * 1024 * 1024).map((_v, i) => (i * 2654435761) >>> 24)
    const members = Array.from({ length: 5 }, (_v, i) => ({
      name: `part${i}.bin`,
      data: noise,
      stored: true,
    }))
    expect(reasonOf(() => parseDocx(buildZip(members), limits))).toBe('processing_failed')
  })

  test.each([
    ['a parent directory', '../evil.xml'],
    ['an absolute path', '/etc/passwd'],
    ['a backslash path', 'word\\document.xml'],
    ['a drive path', 'C:/windows/x'],
    ['a nested parent', 'word/../../x'],
  ])('%s in an entry name is unreadable', (_label, name) => {
    const bytes = buildZip([
      { name: '[Content_Types].xml', data: CT },
      { name: 'word/document.xml', data: '<w:document/>' },
      { name, data: 'x' },
    ])
    expect(reasonOf(() => parseDocx(bytes, limits))).toBe('unreadable')
  })

  test('two entries with one name are unreadable', () => {
    const bytes = buildZip([
      { name: 'word/document.xml', data: '<a/>' },
      { name: 'word/document.xml', data: '<w:document/>' },
    ])
    expect(reasonOf(() => parseDocx(bytes, limits))).toBe('unreadable')
  })

  test('archives nested to any depth are never opened: the outer one has no document', () => {
    let inner: Uint8Array = docxWith('<w:p><w:r><w:t>deep</w:t></w:r></w:p>')
    for (let level = 0; level < 50; level++) {
      inner = buildZip([{ name: `level${level}.zip`, data: inner }])
    }
    expect(reasonOf(() => parseDocx(inner, limits))).toBe('unreadable')
  })

  test('a corrupt deflate stream and a bad checksum are unreadable', () => {
    const good = docxWith('<w:p><w:r><w:t>x</w:t></w:r></w:p>')
    const crcBroken = good.slice()
    const view = new DataView(crcBroken.buffer)
    for (let at = 0; at < crcBroken.length - 4; at++) {
      if (view.getUint32(at, true) === 0x02014b50) {
        view.setUint32(at + 16, 0xdeadbeef, true)
      }
    }
    expect(reasonOf(() => parseDocx(crcBroken, limits))).toBe('unreadable')
    const garbage = concat([
      encoder.encode('PK\u0003\u0004'),
      deflateRawSync(encoder.encode('x')).subarray(0, 1),
    ])
    expect(reasonOf(() => parseDocx(garbage, limits))).toBe('unreadable')
  })

  test('a truncated archive is unreadable', () => {
    const good = docxWith('<w:p/>')
    expect(reasonOf(() => parseDocx(good.subarray(0, good.length - 30), limits))).toBe('unreadable')
  })
})

describe('hostile XML', () => {
  const doc = (xml: string) => buildZip([{ name: 'word/document.xml', data: xml }])

  test('a document type declaration is refused, so no entity is ever defined or fetched', () => {
    const external = `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY e SYSTEM "file:///etc/passwd">]><w:document ${WORD}><w:body><w:p><w:r><w:t>&e;</w:t></w:r></w:p></w:body></w:document>`
    expect(reasonOf(() => parseDocx(doc(external), limits))).toBe('unreadable')
    const laughs = `<!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><w:document ${WORD}><w:body><w:p><w:r><w:t>&b;</w:t></w:r></w:p></w:body></w:document>`
    expect(reasonOf(() => parseDocx(doc(laughs), limits))).toBe('unreadable')
  })

  test('an undeclared entity stays literal text; numeric and predefined ones decode', () => {
    const xml = `<w:document ${WORD}><w:body><w:p><w:r><w:t>&e; &#65;&#x42; &lt;&amp;&#0;</w:t></w:r></w:p></w:body></w:document>`
    expect(parseDocx(doc(xml), limits).pages[0]?.text).toBe('&e; AB <&�\n')
  })

  test('element nesting deeper than the limit is unreadable, without recursion', () => {
    const depth = 10_000
    const xml = `<w:document ${WORD}>${'<w:x>'.repeat(depth)}${'</w:x>'.repeat(depth)}</w:document>`
    expect(reasonOf(() => parseDocx(doc(xml), limits))).toBe('unreadable')
    expect(XML_MAX_DEPTH).toBeLessThan(depth)
  })

  test.each([
    ['an unclosed element', `<w:document ${WORD}><w:body>`],
    ['a mismatched end tag', `<w:document ${WORD}></w:body></w:document>`],
    ['an unterminated comment', `<w:document ${WORD}><!-- never ends`],
    ['an unterminated tag', `<w:document ${WORD}><w:p`],
    ['an unterminated CDATA section', `<w:document ${WORD}><![CDATA[ never ends`],
  ])('%s is unreadable', (_label, xml) => {
    expect(reasonOf(() => parseDocx(doc(xml), limits))).toBe('unreadable')
  })

  test('comments, processing instructions and CDATA are handled', () => {
    const xml = `<?xml version="1.0"?><w:document ${WORD}><!-- note --><w:body><w:p><w:r><w:t><![CDATA[a <b> c]]></w:t></w:r></w:p></w:body></w:document>`
    expect(parseDocx(doc(xml), limits).pages[0]?.text).toBe('a <b> c\n')
  })

  test('a quoted ">" inside an attribute does not end the tag', () => {
    const seen: string[] = []
    scanXml('<a x="1>2" y=\'<\'><b/></a>', {
      start: (name) => seen.push(name),
      end: () => undefined,
      text: () => undefined,
    })
    expect(seen).toEqual(['a', 'b'])
  })
})
