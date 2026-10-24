import { expect, test } from 'bun:test'
import { suggestionPhraserBehaviour } from '~/ports/suggestion-phraser.behaviour'
import { createMemorySuggestionPhraser } from './suggestion-phraser'

suggestionPhraserBehaviour('memory phraser', () => createMemorySuggestionPhraser())

test('a template never exceeds 1000 characters, however long the Moment', async () => {
  const phraser = createMemorySuggestionPhraser()

  const [proposal] = await phraser.propose([{ prospect: 'x'.repeat(5000), agentReply: 'ok' }], {
    signal: new AbortController().signal,
  })

  expect(proposal?.text.length).toBeLessThanOrEqual(1000)
})

test('a scripted answer replaces the templates and every call is recorded', async () => {
  const phraser = createMemorySuggestionPhraser()
  phraser.script(() => [{ kind: 'closing_move', text: 'Scripted', cited: [0] }])
  const moments = [{ prospect: 'p', agentReply: 'a' }]

  const proposals = await phraser.propose(moments, { signal: new AbortController().signal })

  expect(proposals.map((p) => p.text)).toEqual(['Scripted'])
  expect(phraser.calls).toEqual([moments])
})
