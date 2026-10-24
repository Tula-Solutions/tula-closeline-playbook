import { describe, expect, test } from 'bun:test'
import { MAX_PHRASER_MOMENTS, type SuggestionPhraser } from './suggestion-phraser'

/** The behaviour every {@link SuggestionPhraser} must show; run it against each adapter. */
export function suggestionPhraserBehaviour(name: string, make: () => SuggestionPhraser): void {
  describe(`SuggestionPhraser behaviour: ${name}`, () => {
    const moment = { prospect: 'It is too expensive', agentReply: 'We can start small.' }

    test('cites only positions of the Moments it was given', async () => {
      const proposals = await make().propose([moment, moment], {
        signal: new AbortController().signal,
      })

      for (const proposal of proposals) {
        for (const position of proposal.cited) {
          expect(position).toBeGreaterThanOrEqual(0)
          expect(position).toBeLessThan(2)
        }
      }
    })

    test('more Moments than the maximum is a RangeError', async () => {
      const moments = Array.from({ length: MAX_PHRASER_MOMENTS + 1 }, () => moment)

      await expect(
        make().propose(moments, { signal: new AbortController().signal })
      ).rejects.toThrow(RangeError)
    })

    test('an aborted signal rejects the call', async () => {
      const controller = new AbortController()
      controller.abort()

      await expect(make().propose([moment], { signal: controller.signal })).rejects.toThrow()
    })
  })
}
