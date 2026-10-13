import { crc32, deflateRawSync } from 'node:zlib'

const encoder = new TextEncoder()

/** Escapes text for a PDF literal string. */
function pdfString(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`)
}

/** Options of {@link buildPdf}. */
export type PdfOptions = {
  /** The text of each page; an empty string makes a page with no text layer. */
  pages: string[]
  /** Adds an `/Encrypt` entry that no empty password satisfies. */
  encrypted?: boolean
  /** What the page tree root claims as its page count, whatever the pages are. */
  declaredCount?: number
  /** Wraps the pages in this many nested page tree nodes, each holding only the next. */
  nestedDepth?: number
}

/** Builds a small valid PDF in code, one Helvetica line of text per page. */
export function buildPdf(options: PdfOptions): Uint8Array {
  const objects: string[] = []
  const count = options.pages.length
  // 1 catalog, 2 pages, 3 font, then per page a page object and a content stream.
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  const depth = options.nestedDepth ?? 0
  // Nested nodes sit after the pages: 4 + 2 * count + level.
  const nodeId = (level: number) => (level === 0 ? 2 : 4 + 2 * count + level - 1)
  const kids = options.pages.map((_p, i) => `${4 + i * 2} 0 R`).join(' ')
  const declared = options.declaredCount ?? count
  for (let level = 0; level <= depth; level++) {
    const children = level === depth ? kids : `${nodeId(level + 1)} 0 R`
    objects[nodeId(level)] =
      `<< /Type /Pages ${level === 0 ? '' : `/Parent ${nodeId(level - 1)} 0 R `}/Kids [${children}] /Count ${level === 0 ? declared : count} >>`
  }
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  options.pages.forEach((text, i) => {
    const content = text === '' ? '' : `BT /F1 12 Tf 72 720 Td (${pdfString(text)}) Tj ET`
    objects[4 + i * 2] =
      `<< /Type /Page /Parent ${nodeId(depth)} 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`
    objects[5 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  })
  let encryptRef = ''
  if (options.encrypted) {
    const id = objects.length
    const hex = (n: number) => '00'.repeat(n)
    objects[id] = `<< /Filter /Standard /V 1 /R 2 /P -4 /O <${hex(32)}> /U <${'ab'.repeat(32)}> >>`
    encryptRef = ` /Encrypt ${id} 0 R /ID [<${hex(16)}> <${hex(16)}>]`
  }
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = out.length
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let n = 1; n < objects.length; n++) {
    out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R${encryptRef} >>\nstartxref\n${xref}\n%%EOF\n`
  return encoder.encode(out)
}

/** One member of a zip built by {@link buildZip}. */
export type ZipMember = {
  name: string
  data: Uint8Array | string
  /** Stores the member without compression. */
  stored?: boolean
}

/** Builds a zip archive in code (central directory, no extras), for fixtures and hostile inputs. */
export function buildZip(members: ZipMember[]): Uint8Array {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const member of members) {
    const name = encoder.encode(member.name)
    const raw = typeof member.data === 'string' ? encoder.encode(member.data) : member.data
    const body = member.stored ? raw : deflateRawSync(raw)
    const method = member.stored ? 0 : 8
    const crc = crc32(raw)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(8, method, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, body.length, true)
    local.setUint32(22, raw.length, true)
    local.setUint16(26, name.length, true)
    parts.push(new Uint8Array(local.buffer), name, body)
    const entry = new DataView(new ArrayBuffer(46))
    entry.setUint32(0, 0x02014b50, true)
    entry.setUint16(4, 20, true)
    entry.setUint16(6, 20, true)
    entry.setUint16(10, method, true)
    entry.setUint32(16, crc, true)
    entry.setUint32(20, body.length, true)
    entry.setUint32(24, raw.length, true)
    entry.setUint16(28, name.length, true)
    entry.setUint32(42, offset, true)
    central.push(new Uint8Array(entry.buffer), name)
    offset += 30 + name.length + body.length
  }
  const size = central.reduce((sum, part) => sum + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, members.length, true)
  end.setUint16(10, members.length, true)
  end.setUint32(12, size, true)
  end.setUint32(16, offset, true)
  return concat([...parts, ...central, new Uint8Array(end.buffer)])
}

/** Joins byte arrays. */
export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const xmlEscape = (text: string) =>
  text.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'))

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'

/** Builds a DOCX whose body holds `paragraphs`, with an explicit page break before each entry of `breakBefore`. */
export function buildDocx(
  paragraphs: string[],
  options: { pageBreakEvery?: number } = {}
): Uint8Array {
  const body = paragraphs
    .map((text, i) => {
      const brk =
        options.pageBreakEvery !== undefined && i > 0 && i % options.pageBreakEvery === 0
          ? '<w:r><w:br w:type="page"/></w:r>'
          : ''
      return `<w:p>${brk}<w:r><w:t>${xmlEscape(text)}</w:t></w:r></w:p>`
    })
    .join('')
  return buildZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    },
  ])
}

/** Builds a PPTX with one slide per entry; each slide's entry is its paragraphs. */
export function buildPptx(slides: string[][]): Uint8Array {
  const members: ZipMember[] = [{ name: '[Content_Types].xml', data: CONTENT_TYPES }]
  slides.forEach((paragraphs, i) => {
    const body = paragraphs
      .map((text) => `<a:p><a:r><a:t>${xmlEscape(text)}</a:t></a:r></a:p>`)
      .join('')
    members.push({
      name: `ppt/slides/slide${i + 1}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${body}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    })
  })
  return buildZip(members)
}
