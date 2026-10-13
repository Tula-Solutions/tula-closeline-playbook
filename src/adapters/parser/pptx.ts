import { type ParsedDocument, ParseError } from '~/ports/parser'
import type { ParserLimits } from './limits'
import { PageSink } from './pages'
import { scanXml, xmlAttribute } from './xml'
import { ZipArchive } from './zip'

/** The most one slide, the presentation part or its relationships may inflate to. */
const PART_MAX_BYTES = 16 * 1024 * 1024

const SLIDE_NAME = /^ppt\/slides\/slide(\d+)\.xml$/

/** The text of one XML part decoded from its bytes. */
function partText(archive: ZipArchive, name: string): string {
  return new TextDecoder('utf-8').decode(archive.read(name, PART_MAX_BYTES))
}

/**
 * The slide parts in presentation order: the order of `p:sldId` in `ppt/presentation.xml`, resolved
 * through its relationships; the numeric order of the file names when that gives no slide.
 */
function slideOrder(archive: ZipArchive): string[] {
  const files = archive
    .names()
    .filter((name) => SLIDE_NAME.test(name))
    .sort((a, b) => Number(SLIDE_NAME.exec(a)?.[1]) - Number(SLIDE_NAME.exec(b)?.[1]))
  if (!archive.has('ppt/presentation.xml') || !archive.has('ppt/_rels/presentation.xml.rels')) {
    return files
  }
  const targets = new Map<string, string>()
  scanXml(partText(archive, 'ppt/_rels/presentation.xml.rels'), {
    start(name, attributes) {
      const id = xmlAttribute(attributes, 'Id')
      const target = xmlAttribute(attributes, 'Target')
      if (name === 'Relationship' && id !== undefined && target !== undefined) {
        targets.set(id, target.startsWith('/') ? target.slice(1) : `ppt/${target}`)
      }
    },
    end() {},
    text() {},
  })
  const ordered: string[] = []
  const seen = new Set<string>()
  scanXml(partText(archive, 'ppt/presentation.xml'), {
    start(name, attributes) {
      const target =
        name === 'sldId' ? targets.get(xmlAttribute(attributes, 'r:id') ?? '') : undefined
      if (
        target !== undefined &&
        SLIDE_NAME.test(target) &&
        archive.has(target) &&
        !seen.has(target)
      ) {
        // A part listed again is read once: the first place wins.
        seen.add(target)
        ordered.push(target)
      }
    },
    end() {},
    text() {},
  })
  return ordered.length > 0 ? ordered : files
}

/**
 * Parses a PPTX: one page per slide, in presentation order, from the slide parts only (notes,
 * masters, media, macros and embedded objects are never opened). The slide count is checked against
 * the page limit before any slide is inflated.
 */
export function parsePptx(bytes: Uint8Array, limits: ParserLimits): ParsedDocument {
  const archive = new ZipArchive(bytes)
  if (!archive.has('[Content_Types].xml')) {
    throw new ParseError('unreadable')
  }
  const slides = slideOrder(archive)
  if (slides.length === 0) {
    throw new ParseError('unreadable')
  }
  if (slides.length > limits.maxPages) {
    throw new ParseError('too_many_pages', { pageCount: slides.length })
  }
  const sink = new PageSink(limits)
  for (const name of slides) {
    let text = ''
    let inText = false
    let skipping = 0
    scanXml(partText(archive, name), {
      start(element) {
        if (element === 'Fallback') {
          skipping++
        }
        if (skipping > 0) {
          return
        }
        if (element === 't') {
          inText = true
        } else if (element === 'tab') {
          text += '\t'
        } else if (element === 'br') {
          text += '\n'
        }
      },
      end(element) {
        if (element === 'Fallback') {
          skipping--
        } else if (skipping === 0) {
          if (element === 't') {
            inText = false
          } else if (element === 'p') {
            text += '\n'
          }
        }
      },
      text(chunk) {
        if (inText && skipping === 0) {
          text += chunk
          if (text.length > limits.maxTextChars) {
            throw new ParseError('processing_failed')
          }
        }
      },
    })
    sink.push(text)
  }
  return { pages: sink.finish() }
}
