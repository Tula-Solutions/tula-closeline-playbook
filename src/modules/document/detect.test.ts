import { describe, expect, test } from 'bun:test'
import { detectDocumentType } from './detect'

const bytes = (text: string) => new TextEncoder().encode(text)
const zip = (inside: string) => bytes(`PK\u0003\u0004\u0014\u0000${inside}`)

describe('detectDocumentType', () => {
  test.each([
    ['a PDF', 'a.pdf', bytes('%PDF-1.7\nrest'), 'pdf'],
    ['a PDF with junk before the marker', 'a.PDF', bytes(`junk${'x'.repeat(500)}%PDF-1.4`), 'pdf'],
    ['a DOCX', 'a.docx', zip('word/document.xml'), 'docx'],
    ['a PPTX', 'a.pptx', zip('ppt/presentation.xml'), 'pptx'],
    ['a text file', 'a.txt', bytes('plain words, naïve café'), 'txt'],
    ['a Markdown file', 'a.md', bytes('# Title\n\n- item'), 'md'],
  ])('%s is recognised', (_label, name, content, expected) => {
    expect(detectDocumentType(content, name)).toBe(expected as never)
  })

  test.each([
    ['a PDF whose marker is too deep', 'a.pdf', bytes(`${'x'.repeat(2000)}%PDF-1.4`)],
    ['text called a PDF', 'a.pdf', bytes('hello')],
    ['a DOCX that is a PowerPoint', 'a.docx', zip('ppt/presentation.xml')],
    ['a PPTX that is Word', 'a.pptx', zip('word/document.xml')],
    ['a ZIP of neither', 'a.docx', zip('something/else.xml')],
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
})
