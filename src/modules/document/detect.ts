import { isUtf8 } from 'node:buffer'
import { type AcceptedDocumentExtension, documentExtension } from 'tula-closeline-contract'

/** The file type recorded for a document once its content has been looked at (the db library's `DOCUMENT_FILE_TYPES`). */
export type DocumentFileType = 'pdf' | 'docx' | 'pptx' | 'txt' | 'md'

/** How far into a PDF its `%PDF-` marker may sit: the specification allows junk before it. */
const PDF_MARKER_WINDOW = 1024

/** The first bytes of a PDF. */
const PDF_MARKER = Buffer.from('%PDF-')

/** The first bytes of a ZIP archive, which a DOCX and a PPTX are. */
const ZIP_MARKER = Buffer.from([0x50, 0x4b, 0x03, 0x04])

/** A folder every DOCX has and every PPTX lacks. */
const DOCX_FOLDER = Buffer.from('word/')

/** A folder every PPTX has and every DOCX lacks. */
const PPTX_FOLDER = Buffer.from('ppt/')

/** How much of a text file is searched for a NUL byte; text with one later is left to the parser. */
const TEXT_PROBE_BYTES = 8192

/**
 * What the content of `bytes` says the file is, given the extension its name claims: the file type,
 * or `undefined` when the content does not look like that type. Uploads are untrusted (ADR 0016),
 * so the name and the declared media type are never enough. This is a cheap check of the markers
 * a real file of the type has, not a parse: a PDF starts with `%PDF-`; a DOCX or PPTX is a ZIP
 * archive that names its `word/` or `ppt/` folder; a text file is valid UTF-8 with no NUL byte in
 * its first 8 KiB. A file that passes and still cannot be read ends `failed` in the ingestion job.
 * It allocates nothing proportional to the file.
 */
export function detectDocumentType(
  bytes: Uint8Array,
  fileName: string
): DocumentFileType | undefined {
  const extension: AcceptedDocumentExtension | undefined = documentExtension(fileName)
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  switch (extension) {
    case '.pdf':
      return buffer.subarray(0, PDF_MARKER_WINDOW).includes(PDF_MARKER) ? 'pdf' : undefined
    case '.docx':
      return isZip(buffer) && buffer.includes(DOCX_FOLDER) && !buffer.includes(PPTX_FOLDER)
        ? 'docx'
        : undefined
    case '.pptx':
      return isZip(buffer) && buffer.includes(PPTX_FOLDER) && !buffer.includes(DOCX_FOLDER)
        ? 'pptx'
        : undefined
    case '.txt':
    case '.md':
      return isText(buffer) ? (extension === '.md' ? 'md' : 'txt') : undefined
    default:
      return undefined
  }
}

function isZip(buffer: Buffer): boolean {
  return (
    buffer.length >= ZIP_MARKER.length && buffer.subarray(0, ZIP_MARKER.length).equals(ZIP_MARKER)
  )
}

function isText(buffer: Buffer): boolean {
  return !buffer.subarray(0, TEXT_PROBE_BYTES).includes(0) && isUtf8(buffer)
}
