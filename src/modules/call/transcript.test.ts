import { describe, expect, test } from 'bun:test'
import { MAX_CALL_SPEAKERS } from 'tula-closeline-contract'
import {
  MAX_TURN_CHARACTERS,
  MAX_TURNS_PER_CALL,
  parseTranscript,
  type TranscriptMediaType,
} from './transcript'

const encode = (text: string) => new TextEncoder().encode(text)
const parse = (text: string, type: TranscriptMediaType = 'text/plain') =>
  parseTranscript(encode(text), type)

describe('plain text', () => {
  test('reads Label: text lines, merges a speaker running on, and continues unlabelled lines', () => {
    const result = parse(
      [
        'Alice: Hello there.',
        'Alice: How are you?',
        'Bob: Fine, thanks.',
        'and you?',
        '',
        '[00:01:02] Alice: Great.',
      ].join('\n')
    )

    expect(result).toEqual({
      ok: true,
      transcript: {
        speakers: ['Alice', 'Bob'],
        turns: [
          { speaker: 'Alice', text: 'Hello there. How are you?' },
          { speaker: 'Bob', text: 'Fine, thanks. and you?' },
          { speaker: 'Alice', text: 'Great.' },
        ],
      },
    })
  })

  test('a URL in the text is not a label', () => {
    const result = parse('A: see http://example.com/x\nB: ok')

    expect(result.ok && result.transcript.turns[0]?.text).toBe('see http://example.com/x')
  })

  test('strips control and direction characters from labels and collapses whitespace in text', () => {
    const result = parse('‮Al\u0007ice‬:   spaced \t out\nBob: x')

    expect(result.ok && result.transcript.speakers).toEqual(['Alice', 'Bob'])
    expect(result.ok && result.transcript.turns[0]?.text).toBe('spaced out')
  })

  test('cuts a very long turn and keeps the speakers', () => {
    const result = parse(`A: ${'x'.repeat(MAX_TURN_CHARACTERS * 2)}\nB: y`)

    expect(result.ok && result.transcript.turns[0]?.text.length).toBe(MAX_TURN_CHARACTERS)
  })
})

describe('WebVTT and SRT', () => {
  test('WebVTT with voice tags and Label: prefixes, cue ids and notes', () => {
    const result = parse(
      [
        'WEBVTT',
        '',
        'NOTE a comment',
        '',
        '1',
        '00:00:01.000 --> 00:00:03.000',
        '<v Alice>Hi <b>there</b></v>',
        '',
        '2',
        '00:00:03.000 --> 00:00:05.000',
        'Bob: Hello',
        '',
        '00:00:05.000 --> 00:00:06.000',
        'and welcome',
      ].join('\n'),
      'text/vtt'
    )

    expect(result).toEqual({
      ok: true,
      transcript: {
        speakers: ['Alice', 'Bob'],
        turns: [
          { speaker: 'Alice', text: 'Hi there' },
          { speaker: 'Bob', text: 'Hello and welcome' },
        ],
      },
    })
  })

  test('SRT with indexes and CRLF line ends', () => {
    const result = parse(
      '1\r\n00:00:01,000 --> 00:00:02,000\r\nA: one\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\nB: two\r\n',
      'application/x-subrip'
    )

    expect(result.ok && result.transcript.turns.map((t) => t.text)).toEqual(['one', 'two'])
  })
})

describe('JSON', () => {
  test('an array of turns, or an object with turns, with the usual key names', () => {
    const array = parse(
      JSON.stringify([
        { speaker: 'A', text: 'one' },
        { label: 'B', content: 'two' },
      ]),
      'application/json'
    )
    const object = parse(
      JSON.stringify({
        turns: [
          { name: 'A', message: 'one' },
          { speaker: 'B', text: 'two' },
        ],
      }),
      'application/json'
    )

    expect(array.ok && array.transcript.speakers).toEqual(['A', 'B'])
    expect(object.ok && object.transcript.turns).toHaveLength(2)
  })

  test.each([
    ['not JSON', '{nope'],
    ['a number', '3'],
    ['an item that is not an object', '[1]'],
    ['a turn with no speaker', '[{"text":"x"}]'],
  ])('%s is unreadable', (_label, text) => {
    expect(parse(text, 'application/json')).toEqual({ ok: false, reason: 'unreadable' })
  })
})

describe('the failure reasons', () => {
  test('bytes that are not UTF-8, or hold a NUL, are unreadable', () => {
    expect(parseTranscript(new Uint8Array([0x41, 0x3a, 0x20, 0xff, 0xfe]), 'text/plain')).toEqual({
      ok: false,
      reason: 'unreadable',
    })
    expect(parse('A: x\u0000y\nB: z')).toEqual({ ok: false, reason: 'unreadable' })
  })

  test('no turns, one speaker, too many speakers', () => {
    expect(parse('   \n\n')).toEqual({ ok: false, reason: 'no_turns' })
    expect(parse('just prose with no label at all')).toEqual({ ok: false, reason: 'no_turns' })
    expect(parse('A: hi\nA: again')).toEqual({ ok: false, reason: 'too_few_speakers' })
    const many = Array.from({ length: MAX_CALL_SPEAKERS + 1 }, (_, i) => `S${i}: hi`).join('\n')
    expect(parse(many)).toEqual({ ok: false, reason: 'too_many_speakers' })
    const exactly = Array.from({ length: MAX_CALL_SPEAKERS }, (_, i) => `S${i}: hi`).join('\n')
    expect(parse(exactly).ok).toBe(true)
  })

  test('more turns than the bound is unreadable, and exactly the bound is read', () => {
    const turns = (n: number) =>
      Array.from({ length: n }, (_, i) => `${i % 2 === 0 ? 'A' : 'B'}: line ${i}`).join('\n')

    expect(parse(turns(MAX_TURNS_PER_CALL)).ok).toBe(true)
    expect(parse(turns(MAX_TURNS_PER_CALL + 1))).toEqual({ ok: false, reason: 'unreadable' })
  })

  test('a failure carries no text of the file', () => {
    const secret = 'ACME-SECRET-LABEL'
    const result = parse(`${secret}: only one speaker says this`)

    expect(JSON.stringify(result)).not.toContain(secret)
  })

  test('a line over the bound is unreadable', () => {
    expect(parse(`A: ${'x'.repeat(30_000)}\nB: y`)).toEqual({ ok: false, reason: 'unreadable' })
  })
})
