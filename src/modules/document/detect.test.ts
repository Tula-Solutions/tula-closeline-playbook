import { describe, expect, test } from 'bun:test'
import { detectDocumentType } from './detect'
import { zipFixture } from './zip-fixture'

const bytes = (text: string) => new TextEncoder().encode(text)
const names = (...entries: string[]) => zipFixture(entries.map((name) => ({ name })))
const office = (folder: string) => names('[Content_Types].xml', `${folder}document.xml`)

describe('detectDocumentType', () => {
  test.each([
    ['a PDF', 'a.pdf', bytes('%PDF-1.7\nrest'), 'pdf'],
    ['a PDF with junk before the marker', 'a.PDF', bytes(`junk${'x'.repeat(500)}%PDF-1.4`), 'pdf'],
    ['a DOCX', 'a.docx', office('word/'), 'docx'],
    ['a PPTX', 'a.pptx', office('ppt/'), 'pptx'],
    ['a text file', 'a.txt', bytes('plain words, naïve café'), 'txt'],
    ['a Markdown file', 'a.md', bytes('# Title\n\n- item'), 'md'],
  ])('%s is recognised', (_label, name, content, expected) => {
    expect(detectDocumentType(content, name)).toBe(expected as never)
  })

  test.each([
    ['a PDF whose marker is too deep', 'a.pdf', bytes(`${'x'.repeat(2000)}%PDF-1.4`)],
    ['text called a PDF', 'a.pdf', bytes('hello')],
    ['a DOCX that is a PowerPoint', 'a.docx', office('ppt/')],
    ['a PPTX that is Word', 'a.pptx', office('word/')],
    ['a ZIP of neither', 'a.docx', names('[Content_Types].xml', 'something/else.xml')],
    ['a package with no content types part', 'a.docx', names('word/document.xml')],
    ['a ZIP with a Word folder but also a PowerPoint one is still Word', 'a.pptx', office('word/')],
    ['a ZIP that is only a local header', 'a.docx', bytes('PK\u0003\u0004word/document.xml')],
    ['an executable', 'a.exe', bytes('MZ')],
    ['text with a NUL byte near the start', 'a.txt', new Uint8Array([97, 0, 98])],
    ['bytes that are not UTF-8', 'a.md', new Uint8Array([0xc3, 0x28])],
  ])('%s is not', (_label, name, content) => {
    expect(detectDocumentType(content, name)).toBeUndefined()
  })

  test('reads a view into a larger buffer by its own bytes only', () => {
    const outer = bytes('xxxx%PDF-1.7 yyyy')

    expect(detectDocumentType(outer.subarray(4), 'a.pdf')).toBe('pdf')
    expect(detectDocumentType(outer.subarray(0, 3), 'a.pdf')).toBeUndefined()
  })

  test('a PPTX whose stored media part holds the text word/ is still a PPTX', () => {
    const media = bytes('x word/document.xml [Content_Types].xml x')
    const pptx = zipFixture([
      { name: '[Content_Types].xml' },
      { name: 'ppt/presentation.xml' },
      { name: 'ppt/media/image1.bin', data: media },
    ])

    expect(detectDocumentType(pptx, 'a.pptx')).toBe('pptx')
    expect(detectDocumentType(pptx, 'a.docx')).toBeUndefined()
  })

  test('accepts a ZIP with a comment after the end record', () => {
    const base = office('word/')
    const comment = bytes('c'.repeat(300))
    const withComment = new Uint8Array(base.length + comment.length)
    withComment.set(base)
    withComment.set(comment, base.length)
    new DataView(withComment.buffer).setUint16(base.length - 2, comment.length, true)

    expect(detectDocumentType(withComment, 'a.docx')).toBe('docx')
  })

  describe('a lying directory', () => {
    const patch = (edit: (view: DataView, end: number, start: number) => void) => {
      const file = office('word/')
      const view = new DataView(file.buffer)
      const end = file.length - 22
      edit(view, end, view.getUint32(end + 16, true))
      return file
    }

    test.each([
      [
        'a directory offset past the file',
        (v: DataView, end: number) => v.setUint32(end + 16, 0xfffffff0, true),
      ],
      [
        'a directory size past the file',
        (v: DataView, end: number) => v.setUint32(end + 12, 0x7fffffff, true),
      ],
      [
        'a bad entry signature',
        (v: DataView, _end: number, start: number) => v.setUint32(start, 0, true),
      ],
      [
        'a name length running past the directory',
        (v: DataView, _end: number, start: number) => v.setUint16(start + 28, 60000, true),
      ],
      [
        'an extra length running past the directory',
        (v: DataView, _end: number, start: number) => v.setUint16(start + 30, 60000, true),
      ],
    ])('%s is refused without reading out of bounds', (_label, edit) => {
      expect(detectDocumentType(patch(edit), 'a.docx')).toBeUndefined()
    })

    test('an entry with a name longer than the limit is skipped, not read', () => {
      const long = zipFixture([
        { name: `word/${'a'.repeat(2000)}` },
        { name: '[Content_Types].xml' },
      ])

      expect(detectDocumentType(long, 'a.docx')).toBeUndefined()
    })

    test('a directory claiming 60000 entries stops at the cap', () => {
      const entries = Array.from({ length: 12_000 }, (_, i) => ({ name: `m/${i}` }))
      const file = zipFixture([
        ...entries,
        { name: '[Content_Types].xml' },
        { name: 'word/document.xml' },
      ])

      expect(detectDocumentType(file, 'a.docx')).toBeUndefined()
    })

    test('a file shorter than an end record is refused', () => {
      expect(detectDocumentType(bytes('PK\u0003\u0004'), 'a.docx')).toBeUndefined()
    })
  })
})
