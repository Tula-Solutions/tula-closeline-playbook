import { ParseError } from '~/ports/parser'

/** The deepest element nesting accepted; deeper is `unreadable`. */
export const XML_MAX_DEPTH = 256

/** What {@link scanXml} reports. Names have their namespace prefix removed. */
export type XmlHandlers = {
  /** An element opened; `attributes` is the raw text between the name and the closing bracket. */
  start(name: string, attributes: string): void
  /** An element closed (a self-closing element reports start, then end). */
  end(name: string): void
  /** Character data, with the predefined and numeric entities decoded and nothing else expanded. */
  text(text: string): void
}

const ENTITY = /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

/** Decodes the five predefined entities and numeric references; any other `&...;` stays as written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) {
    return text
  }
  return text.replace(ENTITY, (_all, body: string) => {
    const named = NAMED[body]
    if (named !== undefined) {
      return named
    }
    const code = body.startsWith('#x') ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
      ? '�'
      : String.fromCodePoint(code)
  })
}

/** The value of attribute `name` (prefix included, as written) in a raw attribute string, or `undefined`. */
export function xmlAttribute(attributes: string, name: string): string | undefined {
  let from = 0
  while (true) {
    const at = attributes.indexOf(`${name}=`, from)
    if (at === -1) {
      return undefined
    }
    const before = at === 0 ? ' ' : attributes.charAt(at - 1)
    const quote = attributes.charAt(at + name.length + 1)
    if (/\s/.test(before) && (quote === '"' || quote === "'")) {
      const end = attributes.indexOf(quote, at + name.length + 2)
      return end === -1 ? undefined : decodeEntities(attributes.slice(at + name.length + 2, end))
    }
    from = at + 1
  }
}

/** The name without its namespace prefix. */
function local(name: string): string {
  return name.slice(name.indexOf(':') + 1)
}

/**
 * Walks the XML of an Office part without building a tree. Linear in the text. A document type
 * declaration is refused outright, so no entity is ever defined, resolved or fetched and nothing
 * can expand; processing instructions and comments are skipped; nesting is bounded by
 * {@link XML_MAX_DEPTH} with an explicit stack, not recursion. Malformed markup is `unreadable`.
 */
export function scanXml(xml: string, handlers: XmlHandlers): void {
  const stack: string[] = []
  const length = xml.length
  let at = 0
  while (at < length) {
    const open = xml.indexOf('<', at)
    if (open === -1) {
      handlers.text(decodeEntities(xml.slice(at)))
      return
    }
    if (open > at) {
      handlers.text(decodeEntities(xml.slice(at, open)))
    }
    if (xml.startsWith('<!--', open)) {
      const end = xml.indexOf('-->', open + 4)
      if (end === -1) {
        throw new ParseError('unreadable')
      }
      at = end + 3
    } else if (xml.startsWith('<![CDATA[', open)) {
      const end = xml.indexOf(']]>', open + 9)
      if (end === -1) {
        throw new ParseError('unreadable')
      }
      handlers.text(xml.slice(open + 9, end))
      at = end + 3
    } else if (xml.startsWith('<!', open)) {
      throw new ParseError('unreadable')
    } else if (xml.startsWith('<?', open)) {
      const end = xml.indexOf('?>', open + 2)
      if (end === -1) {
        throw new ParseError('unreadable')
      }
      at = end + 2
    } else {
      const close = tagEnd(xml, open + 1)
      const body = xml.slice(open + 1, close)
      at = close + 1
      if (body.startsWith('/')) {
        const name = local(body.slice(1).trim())
        if (stack.pop() !== name) {
          throw new ParseError('unreadable')
        }
        handlers.end(name)
      } else {
        const selfClosing = body.endsWith('/')
        const inner = selfClosing ? body.slice(0, -1) : body
        const space = inner.search(/\s/)
        const name = local(space === -1 ? inner : inner.slice(0, space))
        if (name === '') {
          throw new ParseError('unreadable')
        }
        handlers.start(name, space === -1 ? '' : inner.slice(space))
        if (selfClosing) {
          handlers.end(name)
        } else {
          if (stack.push(name) > XML_MAX_DEPTH) {
            throw new ParseError('unreadable')
          }
        }
      }
    }
  }
  if (stack.length > 0) {
    throw new ParseError('unreadable')
  }
}

/** The index of the `>` that ends the tag starting at `from`, skipping quoted attribute values. */
function tagEnd(xml: string, from: number): number {
  let quote = ''
  for (let at = from; at < xml.length; at++) {
    const char = xml.charAt(at)
    if (quote !== '') {
      if (char === quote) {
        quote = ''
      }
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return at
    }
  }
  throw new ParseError('unreadable')
}
