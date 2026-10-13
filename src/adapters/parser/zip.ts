import { crc32, inflateRawSync } from 'node:zlib'
import { ParseError } from '~/ports/parser'

/** The bounds an archive must stay within, checked from its central directory before anything is inflated. */
export type ZipLimits = {
  /** The most entries an archive may list. */
  maxEntries: number
  /** The most bytes one entry may inflate to. */
  maxEntryBytes: number
  /** The most bytes all entries together may inflate to. */
  maxTotalBytes: number
  /** The most an entry larger than {@link ZipLimits.ratioFloorBytes} may inflate to per compressed byte. */
  maxRatio: number
  /** Entries up to this size are exempt from the ratio check, since the size limits already bound them. */
  ratioFloorBytes: number
}

/** The limits of Office archives: a 25 MB upload of real XML is far below each of them. */
export const OFFICE_ZIP_LIMITS: ZipLimits = {
  maxEntries: 5_000,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxRatio: 150,
  ratioFloorBytes: 1024 * 1024,
}

/** One entry of an archive's central directory. */
type ZipEntry = {
  method: number
  encrypted: boolean
  crc: number
  compressedSize: number
  size: number
  offset: number
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const EOCD_MIN = 22
const MAX_COMMENT = 0xffff
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

/** A zip archive opened for reading named entries under {@link ZipLimits}. */
export class ZipArchive {
  private readonly entries = new Map<string, ZipEntry>()

  /** Reads the central directory of `bytes` and checks every limit that does not need inflation; throws a {@link ParseError}. */
  constructor(
    private readonly bytes: Uint8Array,
    private readonly limits: ZipLimits = OFFICE_ZIP_LIMITS
  ) {
    if (CFB_MAGIC.every((byte, at) => bytes[at] === byte)) {
      // An Office file protected with a password is stored in this container, not in a zip.
      throw new ParseError('password_protected')
    }
    this.readDirectory()
  }

  /** The names of the entries, in directory order. */
  names(): string[] {
    return [...this.entries.keys()]
  }

  /** Whether the archive has an entry called `name`. */
  has(name: string): boolean {
    return this.entries.has(name)
  }

  /** Inflates one entry, never past its declared size or `maxBytes`; a lie, a flaw or a limit is a {@link ParseError}. */
  read(name: string, maxBytes: number = this.limits.maxEntryBytes): Uint8Array {
    const entry = this.entries.get(name)
    if (entry === undefined) {
      throw new ParseError('unreadable')
    }
    if (entry.encrypted) {
      throw new ParseError('password_protected')
    }
    if (entry.size > maxBytes) {
      throw new ParseError('processing_failed')
    }
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength)
    if (entry.offset + 30 > this.bytes.length || view.getUint32(entry.offset, true) !== LOCAL) {
      throw new ParseError('unreadable')
    }
    const start =
      entry.offset +
      30 +
      view.getUint16(entry.offset + 26, true) +
      view.getUint16(entry.offset + 28, true)
    const end = start + entry.compressedSize
    if (end > this.bytes.length) {
      throw new ParseError('unreadable')
    }
    const stored = this.bytes.subarray(start, end)
    let data: Uint8Array
    if (entry.method === 0) {
      data = stored
    } else if (entry.method === 8) {
      try {
        // The declared size is the ceiling: an entry that inflates past it is lying about itself.
        data = inflateRawSync(stored, { maxOutputLength: Math.max(entry.size, 1) })
      } catch (cause) {
        throw new ParseError('unreadable', { cause })
      }
    } else {
      throw new ParseError('unreadable')
    }
    if (data.length !== entry.size || crc32(data) !== entry.crc) {
      throw new ParseError('unreadable')
    }
    return data
  }

  private readDirectory(): void {
    const { bytes, limits } = this
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let eocd = -1
    for (
      let at = bytes.length - EOCD_MIN;
      at >= Math.max(0, bytes.length - EOCD_MIN - MAX_COMMENT);
      at--
    ) {
      if (view.getUint32(at, true) === EOCD) {
        eocd = at
        break
      }
    }
    if (eocd === -1) {
      throw new ParseError('unreadable')
    }
    const disk = view.getUint16(eocd + 4, true)
    const directoryDisk = view.getUint16(eocd + 6, true)
    const count = view.getUint16(eocd + 10, true)
    const size = view.getUint32(eocd + 12, true)
    const offset = view.getUint32(eocd + 16, true)
    if (disk !== 0 || directoryDisk !== 0 || count === 0xffff || offset === 0xffffffff) {
      // Multi-part and zip64 archives are not needed under a 25 MB upload limit.
      throw new ParseError('unreadable')
    }
    if (count > limits.maxEntries) {
      throw new ParseError('processing_failed')
    }
    if (offset + size > eocd) {
      throw new ParseError('unreadable')
    }
    let at = offset
    let total = 0
    for (let index = 0; index < count; index++) {
      if (at + 46 > offset + size || view.getUint32(at, true) !== CENTRAL) {
        throw new ParseError('unreadable')
      }
      const flags = view.getUint16(at + 8, true)
      const compressedSize = view.getUint32(at + 20, true)
      const uncompressed = view.getUint32(at + 24, true)
      const nameLength = view.getUint16(at + 28, true)
      const extraLength = view.getUint16(at + 30, true)
      const commentLength = view.getUint16(at + 32, true)
      const next = at + 46 + nameLength + extraLength + commentLength
      if (next > offset + size) {
        throw new ParseError('unreadable')
      }
      const name = new TextDecoder('utf-8').decode(bytes.subarray(at + 46, at + 46 + nameLength))
      if (!safeName(name) || this.entries.has(name)) {
        throw new ParseError('unreadable')
      }
      if (compressedSize === 0xffffffff || uncompressed === 0xffffffff) {
        throw new ParseError('unreadable')
      }
      total += uncompressed
      if (
        uncompressed > limits.maxEntryBytes ||
        total > limits.maxTotalBytes ||
        (uncompressed > limits.ratioFloorBytes &&
          uncompressed / Math.max(compressedSize, 1) > limits.maxRatio)
      ) {
        throw new ParseError('processing_failed')
      }
      this.entries.set(name, {
        method: view.getUint16(at + 10, true),
        encrypted: (flags & 1) !== 0,
        crc: view.getUint32(at + 16, true),
        compressedSize,
        size: uncompressed,
        offset: view.getUint32(at + 42, true),
      })
      at = next
    }
  }
}

/** Whether an entry name is a plain relative path: no `..`, no root, no drive, no backslash, no NUL. */
function safeName(name: string): boolean {
  if (name === '' || name.includes('\\') || name.includes('\0') || name.startsWith('/')) {
    return false
  }
  if (/^[A-Za-z]:/.test(name)) {
    return false
  }
  return !name.split('/').some((part) => part === '..')
}
