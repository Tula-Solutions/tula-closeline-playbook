import { MAX_CALL_SPEAKERS, speakerLabelSchema } from 'tula-closeline-contract'
import { z } from 'zod'

/** One turn of a Transcript: who spoke (a label from the file, untrusted text) and what was said. */
export type Turn = { speaker: string; text: string }

/** A parsed Transcript: its turns in order, and its speaker labels in order of first appearance. */
export type ParsedTranscript = { turns: Turn[]; speakers: string[] }

/** Why a Transcript could not be turned into turns, using the contract's failure reasons. */
export type TranscriptProblem = 'unreadable' | 'no_turns' | 'too_few_speakers' | 'too_many_speakers'

/** What {@link parseTranscript} answers. It never carries the file's text in a failure. */
export type TranscriptResult =
  | { ok: true; transcript: ParsedTranscript }
  | { ok: false; reason: TranscriptProblem }

/** The most turns a Transcript may have after adjacent turns of one speaker are merged; more is `unreadable`. A one-hour call has about a thousand. */
export const MAX_TURNS_PER_CALL = 10_000

/** The most characters (UTF-16 units) of one turn that are kept; the rest of a longer turn is dropped. */
export const MAX_TURN_CHARACTERS = 4000

/** The longest line a plain-text, WebVTT or SRT Transcript may have before it is read as `unreadable` (a 5 MB file of one line is not a Transcript). */
const MAX_LINE_CHARACTERS = 20_000

/** A timestamp before a label in a text Transcript: `[00:01:02]`, `00:01:02.500` or `1:02`. */
const LEADING_TIME = String.raw`(?:\[?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\]?\s+)?`

/** `Label: text`, with an optional timestamp first. The label has no colon and at most 64 characters. */
const LABELLED_LINE = new RegExp(`^${LEADING_TIME}([^:\\n]{1,64}?):(?:\\s+(.*))?$`)

/** A WebVTT voice tag at the start of a cue: `<v Label>` or `<v.loud Label>`. */
const VOICE_TAG = /^<v(?:\.[^\s>]*)?\s+([^>]{1,200})>/

const MARKUP = /<[^>]{0,200}>/g
const CONTROL = /\p{Cc}/gu
const TIMING = /-->/

/** Collapses whitespace and strips control characters, then cuts to {@link MAX_TURN_CHARACTERS}. */
function cleanText(raw: string): string {
  const text = raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (text.length <= MAX_TURN_CHARACTERS) {
    return text
  }
  // Never end inside a surrogate pair.
  const cut = text.slice(0, MAX_TURN_CHARACTERS)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/** The label as stored (control and direction characters out, trimmed), or `undefined` when it is not a valid label. */
function labelOf(raw: string): string | undefined {
  const parsed = speakerLabelSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

/** Splits `Label: text`; `undefined` when the line does not start with a valid label. */
function labelled(line: string): Turn | undefined {
  const match = LABELLED_LINE.exec(line)
  if (match === null) {
    return undefined
  }
  const speaker = labelOf(match[1] ?? '')
  if (speaker === undefined) {
    return undefined
  }
  return { speaker, text: match[2] ?? '' }
}

/** Collects turns, merging adjacent turns of one speaker and refusing more than {@link MAX_TURNS_PER_CALL}. */
class TurnCollector {
  readonly turns: Turn[] = []
  private tooMany = false

  /** Adds a turn of `speaker`, or text to the last turn when it is the same speaker's. */
  add(speaker: string, raw: string): void {
    const text = cleanText(raw)
    if (text === '') {
      return
    }
    const last = this.turns.at(-1)
    if (last !== undefined && last.speaker === speaker) {
      last.text = cleanText(`${last.text} ${text}`)
      return
    }
    if (this.turns.length >= MAX_TURNS_PER_CALL) {
      this.tooMany = true
      return
    }
    this.turns.push({ speaker, text })
  }

  /** Adds text to the last turn (a line with no label of its own); text before any turn is dropped. */
  append(raw: string): void {
    const last = this.turns.at(-1)
    const text = cleanText(raw)
    if (last !== undefined && text !== '') {
      last.text = cleanText(`${last.text} ${text}`)
    }
  }

  get overflowed(): boolean {
    return this.tooMany
  }
}

/** Reads `Label: text` lines; a line without a label continues the turn before it. */
function parseLines(lines: Iterable<string>, collector: TurnCollector): boolean {
  for (const line of lines) {
    if (line.length > MAX_LINE_CHARACTERS) {
      return false
    }
    const trimmed = line.trim()
    if (trimmed === '') {
      continue
    }
    const turn = labelled(trimmed)
    if (turn === undefined) {
      collector.append(trimmed)
    } else {
      collector.add(turn.speaker, turn.text)
    }
  }
  return true
}

/** Reads the text of one cue (WebVTT or SRT): a voice tag or `Label: text` names the speaker, else the text continues the turn before. */
function parseCue(payload: string, collector: TurnCollector): void {
  const text = payload.trim()
  const voice = VOICE_TAG.exec(text)
  if (voice !== null) {
    const speaker = labelOf(voice[1] ?? '')
    if (speaker !== undefined) {
      collector.add(speaker, text.slice(voice[0].length).replace(MARKUP, ' '))
      return
    }
  }
  const plain = text.replace(MARKUP, ' ').trim()
  const turn = labelled(plain)
  if (turn === undefined) {
    collector.append(plain)
  } else {
    collector.add(turn.speaker, turn.text)
  }
}

/** Reads WebVTT or SRT: blocks separated by blank lines, each with a timing line and the cue's text after it. */
function parseCues(text: string, collector: TurnCollector, skipHeader: boolean): boolean {
  const blocks = text.split(/\r?\n\s*\r?\n/)
  for (let at = 0; at < blocks.length; at++) {
    const block = blocks[at] ?? ''
    if (block.length > MAX_LINE_CHARACTERS * 4) {
      return false
    }
    if (skipHeader && at === 0 && !TIMING.test(block)) {
      continue
    }
    const lines = block.split(/\r?\n/)
    const timing = lines.findIndex((line) => TIMING.test(line))
    if (timing < 0) {
      continue
    }
    parseCue(lines.slice(timing + 1).join(' '), collector)
  }
  return true
}

const jsonTurnSchema = z.object({
  speaker: z.string().max(1000).optional(),
  label: z.string().max(1000).optional(),
  name: z.string().max(1000).optional(),
  text: z.string().max(200_000).optional(),
  content: z.string().max(200_000).optional(),
  message: z.string().max(200_000).optional(),
})

/** Reads a JSON array of `{ speaker, text }` objects, or `{ turns: [...] }`; `speaker` may be `label` or `name`, and `text` may be `content` or `message`. */
function parseJson(text: string, collector: TurnCollector): boolean {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return false
  }
  const list = Array.isArray(value)
    ? value
    : typeof value === 'object' &&
        value !== null &&
        Array.isArray((value as { turns?: unknown }).turns)
      ? (value as { turns: unknown[] }).turns
      : undefined
  if (list === undefined || list.length > MAX_TURNS_PER_CALL * 4) {
    return false
  }
  for (const item of list) {
    const parsed = jsonTurnSchema.safeParse(item)
    if (!parsed.success) {
      return false
    }
    const speaker = labelOf(parsed.data.speaker ?? parsed.data.label ?? parsed.data.name ?? '')
    const said = parsed.data.text ?? parsed.data.content ?? parsed.data.message ?? ''
    if (speaker === undefined) {
      return false
    }
    collector.add(speaker, said)
  }
  return true
}

/** The media types of a Transcript, as the contract names them. */
export type TranscriptMediaType =
  | 'text/plain'
  | 'text/vtt'
  | 'application/x-subrip'
  | 'application/json'

/**
 * Turns the bytes of a Transcript into turns with speaker labels. The text is untrusted data: it
 * is read by shape only, never as instructions. A file that is not valid UTF-8, holds a NUL, has
 * a line over {@link MAX_LINE_CHARACTERS} or more than {@link MAX_TURNS_PER_CALL} turns is
 * `unreadable`; one with no turns is `no_turns`; with one speaker, `too_few_speakers`; with more
 * than {@link MAX_CALL_SPEAKERS}, `too_many_speakers`. Work is O(file size) and memory is the text
 * and the turns once; a failure never carries any of the file.
 */
export function parseTranscript(
  body: Uint8Array,
  mediaType: TranscriptMediaType
): TranscriptResult {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (text.includes('\u0000')) {
    return { ok: false, reason: 'unreadable' }
  }
  const collector = new TurnCollector()
  let readable: boolean
  switch (mediaType) {
    case 'application/json':
      readable = parseJson(text, collector)
      break
    case 'text/vtt':
      readable = parseCues(text, collector, true)
      break
    case 'application/x-subrip':
      readable = parseCues(text, collector, false)
      break
    default:
      readable = parseLines(text.split(/\r?\n/), collector)
  }
  if (!readable || collector.overflowed) {
    return { ok: false, reason: 'unreadable' }
  }
  const { turns } = collector
  if (turns.length === 0) {
    return { ok: false, reason: 'no_turns' }
  }
  const speakers = [...new Set(turns.map((turn) => turn.speaker))]
  if (speakers.length > MAX_CALL_SPEAKERS) {
    return { ok: false, reason: 'too_many_speakers' }
  }
  if (speakers.length < 2) {
    return { ok: false, reason: 'too_few_speakers' }
  }
  return { ok: true, transcript: { turns, speakers } }
}
