import { describe, expect, test } from 'bun:test'
import { MAX_REP_FOLLOWING_CHARACTERS, MAX_REP_FOLLOWING_TURNS } from 'tula-closeline-contract'
import { buildMoments, MOMENT_CONTEXT_CHARACTERS, MOMENT_CONTEXT_TURNS } from './moments'
import type { Turn } from './transcript'

const turn = (speaker: string, text: string): Turn => ({ speaker, text })

describe('Moments', () => {
  test('one per Prospect turn, with the context up to it and the Rep turns that follow', () => {
    const turns = [
      turn('Rep', 'Hello'),
      turn('Pat', 'Hi, I have a question'),
      turn('Rep', 'Sure'),
      turn('Rep', 'Go ahead'),
      turn('Pat', 'How much is it?'),
      turn('Rep', 'Ten dollars'),
    ]

    const moments = buildMoments(turns, 'Rep')

    expect(moments).toHaveLength(2)
    expect(moments[0]).toMatchObject({
      index: 0,
      turn: 1,
      context: [
        { role: 'rep', text: 'Hello' },
        { role: 'prospect', text: 'Hi, I have a question' },
      ],
      repFollowing: ['Sure', 'Go ahead'],
      text: 'Rep: Hello\nProspect: Hi, I have a question',
    })
    expect(moments[1]).toMatchObject({ index: 1, turn: 4, repFollowing: ['Ten dollars'] })
  })

  test('the text to embed carries roles only: no speaker label and nothing of the Rep reply', () => {
    const moments = buildMoments(
      [turn('Rep', 'Hi'), turn('SECRET-NAME', 'my question'), turn('Rep', 'REPLY-TEXT')],
      'Rep'
    )

    expect(moments[0]?.text).not.toContain('SECRET-NAME')
    expect(moments[0]?.text).not.toContain('REPLY-TEXT')
    expect(JSON.stringify(moments)).not.toContain('SECRET-NAME')
  })

  test('the context holds at most the window of turns', () => {
    const turns = Array.from({ length: 12 }, (_, i) => turn(i % 2 === 0 ? 'Rep' : 'Pat', `t${i}`))

    const last = buildMoments(turns, 'Rep').at(-1)

    expect(last?.context).toHaveLength(MOMENT_CONTEXT_TURNS)
    expect(last?.context.at(-1)?.text).toBe('t11')
  })

  test('the oldest turns go first when the characters run out, and a lone long turn is cut', () => {
    const long = 'x'.repeat(MOMENT_CONTEXT_CHARACTERS - 10)
    const turns = [turn('Rep', long), turn('Pat', 'y'.repeat(50))]
    const dropped = buildMoments(turns, 'Rep')[0]
    const cut = buildMoments([turn('Pat', 'z'.repeat(MOMENT_CONTEXT_CHARACTERS * 2))], 'Rep')[0]

    expect(dropped?.context).toEqual([{ role: 'prospect', text: 'y'.repeat(50) }])
    expect(Array.from(cut?.context[0]?.text ?? '')).toHaveLength(MOMENT_CONTEXT_CHARACTERS)
  })

  test('the Rep turns kept after a Moment are bounded in count and characters', () => {
    const many = [
      turn('Pat', 'q'),
      ...Array.from({ length: 10 }, (_, i) => turn('Rep', `reply ${i}`)),
    ]
    const wide = [turn('Pat', 'q'), turn('Rep', 'r'.repeat(MAX_REP_FOLLOWING_CHARACTERS * 2))]

    expect(buildMoments(many, 'Rep')[0]?.repFollowing).toHaveLength(MAX_REP_FOLLOWING_TURNS)
    expect(Array.from(buildMoments(wide, 'Rep')[0]?.repFollowing[0] ?? '')).toHaveLength(
      MAX_REP_FOLLOWING_CHARACTERS
    )
  })

  test('characters are counted as code points, not UTF-16 units', () => {
    const emoji = '\u{1F600}'.repeat(MOMENT_CONTEXT_CHARACTERS)

    const moment = buildMoments([turn('Pat', emoji)], 'Rep')[0]

    expect(Array.from(moment?.context[0]?.text ?? '')).toHaveLength(MOMENT_CONTEXT_CHARACTERS)
  })

  test('a Transcript with no Prospect turn has no Moment', () => {
    expect(buildMoments([turn('Rep', 'a'), turn('Rep', 'b')], 'Rep')).toEqual([])
  })
})
