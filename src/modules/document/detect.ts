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

/** The signature of the ZIP end-of-central-directory record. */
const EOCD_SIGNATURE = 0x06054b50

/** The signature of a ZIP central-directory entry. */
const CENTRAL_SIGNATURE = 0x02014b50

/** The fixed size of the end-of-central-directory record, and the longest comment that may follow it. */
const EOCD_BYTES = 22
const MAX_ZIP_COMMENT_BYTES = 65_535

/** The fixed size of a central-directory entry before its name, extra field and comment. */
const CENTRAL_ENTRY_BYTES = 46

/** The most central-directory entries read, so a lying directory cannot make the walk long. */
const MAX_ZIP_ENTRIES = 10_000

/** The longest entry name looked at; a longer one is skipped (still walked past by its length). */
const MAX_ENTRY_NAME_BYTES = 512

/** The part every Office Open XML package has. */
const CONTENT_TYPES = '[Content_Types].xml'

/** How much of a text file is searched for a NUL byte; text with one later is left to the parser. */
const TEXT_PROBE_BYTES = 8192

/**
 * What the content of `bytes` says the file is, given the extension its name claims: the file type,
 * or `undefined` when the content does not look like that type. Uploads are untrusted (ADR 0016),
 * so the name and the declared media type are never enough. This is a cheap check of the markers
 * a real file of the type has, not a parse: a PDF starts with `%PDF-`; a DOCX or PPTX is a ZIP
 * archive that names its `word/` or `ppt/` folder; a text file is valid UTF-8 with no NUL byte in
 * its first 8 KiB. For a DOCX or PPTX the entry names come from the ZIP central directory only
 * (never the data, which may hold any string): the package must have `[Content_Types].xml` and an
 * entry under its own folder. A file that passes and still cannot be read ends `failed` in the ingestion job.
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
      return isZip(buffer) && officePackage(buffer, 'word/') ? 'docx' : undefined
    case '.pptx':
      return isZip(buffer) && officePackage(buffer, 'ppt/') ? 'pptx' : undefined
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

/**
 * Whether the ZIP's central directory names `[Content_Types].xml` and an entry under `folder`.
 * Reads entry names only and decompresses nothing. Every offset is checked against the buffer, the
 * entry count and the name length are capped, and a directory that lies (a bad signature, an entry
 * running past the end, an offset outside the file) ends the walk with `false`.
 */
function officePackage(buffer: Buffer, folder: 'word/' | 'ppt/'): boolean {
  const end = findEndOfCentralDirectory(buffer)
  if (end === undefined) {
    return false
  }
  const size = buffer.readUInt32LE(end + 12)
  const start = buffer.readUInt32LE(end + 16)
  const stop = start + size
  if (start === 0xffffffff || stop > buffer.length || stop > end) {
    return false
  }
  let hasContentTypes = false
  let hasFolder = false
  let offset = start
  for (
    let entries = 0;
    entries < MAX_ZIP_ENTRIES && offset + CENTRAL_ENTRY_BYTES <= stop;
    entries++
  ) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      return false
    }
    const nameLength = buffer.readUInt16LE(offset + 28)
    const next =
      offset +
      CENTRAL_ENTRY_BYTES +
      nameLength +
      buffer.readUInt16LE(offset + 30) +
      buffer.readUInt16LE(offset + 32)
    if (next > stop) {
      return false
    }
    if (nameLength <= MAX_ENTRY_NAME_BYTES) {
      const name = buffer.toString(
        'latin1',
        offset + CENTRAL_ENTRY_BYTES,
        offset + CENTRAL_ENTRY_BYTES + nameLength
      )
      hasContentTypes ||= name === CONTENT_TYPES
      hasFolder ||= name.startsWith(folder)
    }
    offset = next
  }
  return hasContentTypes && hasFolder
}

/** The offset of the end-of-central-directory record, searched backwards over the longest comment, or `undefined`. */
function findEndOfCentralDirectory(buffer: Buffer): number | undefined {
  const lowest = Math.max(0, buffer.length - EOCD_BYTES - MAX_ZIP_COMMENT_BYTES)
  for (let offset = buffer.length - EOCD_BYTES; offset >= lowest; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset
    }
  }
  return undefined
}
