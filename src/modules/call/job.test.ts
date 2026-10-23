import { describe, expect, spyOn, test } from 'bun:test'
import {
  type Call,
  callSchema,
  dealSchema,
  listDealsResponseSchema,
  momentSnippet,
} from 'tula-closeline-contract'
import {
  CALL_JOB_CLAIM,
  CALL_JOB_COMPLETE,
  claimedCallJobs,
  DEAL_SET_OUTCOME,
  EMBED_USAGE_ADD,
  EMBED_USAGE_PURGE,
} from 'tula-closeline-db'
import { personIn } from '~/modules/document/test-support'
import { ShuttingDown } from '~/modules/ingestion/runtime'
import { logged } from '~/modules/ingestion/test-support'
import { runCallJob } from './job'
import { purgeCalls } from './purge'
import { CALLS, type CallHarness, createCallHarness, transcriptText } from './test-support'

const SECRET_LABEL = 'Zebediah Quillfeather'
const SECRET_LINE = 'the launch codes are swordfish-7731'

async function upload(h: CallHarness, text: string, options: { dealId?: string } = {}) {
  const response = await h.uploadCall(text, options)
  expect(response.status).toBe(201)
  return callSchema.parse(await response.json())
}

/** The vectors of one Call, as the store returns them. */
async function vectorsOf(h: CallHarness, callId: string, org: string = h.organizationId) {
  return h.deps.vectors.search(org, {
    vector: new Array<number>(h.deps.vectors.dimensions).fill(0.1),
    topK: 100,
    filter: { call_id: callId },
  })
}

describe('processing a Transcript', () => {
  test('a Transcript over the Moment cap embeds the first and the last Moments, ends ready, and records the count skipped', async () => {
    const h = await createCallHarness({ env: { MAX_MOMENTS_PER_CALL: '2' } })
    const call = await upload(h, transcriptText('cap', 5))
    const embed = spyOn(h.deps.embedder, 'embed')

    await h.runCalls()

    expect((await h.readCall(call.id)).state).toBe('ready')
    const hits = await vectorsOf(h, call.id)
    expect(hits.map((hit) => hit.attributes?.moment).sort()).toEqual([0, 4])
    expect(embed.mock.calls.flatMap(([texts]) => texts)).toHaveLength(2)
    const lines = logged(
      h.deps,
      'a Call has more Moments than the cap; the middle ones are not searchable'
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      organizationId: h.organizationId,
      callId: call.id,
      moments: 5,
      cap: 2,
      skipped: 3,
    })
  })

  test('the close of a long Transcript survives the cap: the last Moments are kept', async () => {
    const h = await createCallHarness({ env: { MAX_MOMENTS_PER_CALL: '4' } })
    const call = await upload(h, transcriptText('long', 10))

    await h.runCalls()

    const kept = (await vectorsOf(h, call.id)).map((hit) => hit.attributes?.moment).sort()
    expect(kept).toEqual([0, 1, 8, 9])
  })

  test('a Transcript at the cap skips nothing and logs nothing about it', async () => {
    const h = await createCallHarness({ env: { MAX_MOMENTS_PER_CALL: '3' } })
    const call = await upload(h, transcriptText('exact', 3))

    await h.runCalls()

    expect(await vectorsOf(h, call.id)).toHaveLength(3)
    expect(
      logged(h.deps, 'a Call has more Moments than the cap; the middle ones are not searchable')
    ).toHaveLength(0)
  })

  test('makes the Call ready with its speakers and one tagged vector per Prospect turn', async () => {
    const h = await createCallHarness()
    const call = await upload(h, transcriptText('x', 3))

    expect(await h.runCalls()).toBe(1)

    const ready = await h.readCall(call.id)
    expect(ready).toMatchObject({
      state: 'ready',
      speakerLabels: ['Alex', 'Sam'],
      failureReason: null,
    })
    expect(ready.inSearch).toBe(false)
    const hits = await vectorsOf(h, call.id)
    expect(hits).toHaveLength(3)
    for (const hit of hits) {
      expect(hit.attributes).toMatchObject({
        call_id: call.id,
        epoch: 0,
        rep_seq: 0,
        outcome: 'open',
        outcome_seq: 0,
        v: 2,
      })
      expect(typeof hit.attributes?.prospect).toBe('string')
      expect(typeof hit.attributes?.rep_next).toBe('string')
      expect(String(hit.attributes?.prospect).length).toBeGreaterThan(0)
      expect(String(hit.attributes?.prospect).length).toBeLessThanOrEqual(512)
    }
    // The snippets are the contract's: the Prospect's turn and what the Rep said next.
    expect(hits.map((hit) => hit.attributes?.prospect)).toContain(
      momentSnippet('I have a question about pricing, round 0.')
    )
    expect(hits.map((hit) => hit.attributes?.rep_next)).toContain(
      momentSnippet('Hello x, this is the Rep speaking, turn 1.')
    )
    expect(new Set(hits.map((hit) => hit.id)).size).toBe(3)
    // The embedded text is by role, never a speaker label.
    const embedded = h.deps.embedder.calls.flatMap((c) => c.texts).join('\n')
    expect(embedded).toContain('Prospect')
    expect(embedded).not.toContain('Sam:')
    expect(h.deps.embedder.calls.every((c) => c.purpose === 'document')).toBe(true)
  })

  test('a Deal that is already won is tagged won, and the Call is in search', async () => {
    const h = await createCallHarness()
    const call = await upload(h, transcriptText('won'), { dealId: 'DEAL-W' })
    await h.deps.database.scope(h.organizationId, (run) =>
      run(DEAL_SET_OUTCOME, [
        h.organizationId,
        h.deps.database.deals(h.organizationId)[0]?.id,
        'won',
      ])
    )

    await h.runCalls()

    const hits = await vectorsOf(h, call.id)
    expect(hits[0]?.attributes).toMatchObject({ outcome: 'won' })
    expect((await h.readCall(call.id)).inSearch).toBe(true)
  })

  const failures: [label: string, text: string, rep: string, reason: string][] = [
    ['one speaker', 'Alex: hello\nAlex: again\n', 'Alex', 'too_few_speakers'],
    ['a Rep label not in the file', transcriptText(), 'Nobody', 'rep_label_not_found'],
    ['no turns at all', '   \n\n', 'Alex', 'no_turns'],
  ]
  test.each(failures)('%s fails the Call with %p', async (_label, text, rep, reason) => {
    const h = await createCallHarness()
    const response = await h.uploadCall(text, {
      rep: JSON.stringify({ by: 'speaker', label: rep }),
    })
    // An empty-looking file is refused at the edge; the others reach the job.
    if (response.status !== 201) {
      expect(response.status).toBe(400)
      return
    }
    const call = callSchema.parse(await response.json())

    await h.runCalls()

    const failed = await h.readCall(call.id)
    expect(failed).toMatchObject({ state: 'failed', failureReason: reason })
    expect(await vectorsOf(h, call.id)).toHaveLength(0)
    // The labels the file does hold stay, so the Rep can be changed to one of them.
    if (reason === 'rep_label_not_found') {
      expect(failed.speakerLabels).toEqual(['Alex', 'Sam'])
    }
  })

  test('more than 20 speakers fails too_many_speakers and keeps no labels', async () => {
    const h = await createCallHarness()
    const lines = Array.from({ length: 21 }, (_, i) => `Speaker${i}: hello number ${i}`)
    const call = await upload(h, `${lines.join('\n')}\n`, {})
    await h.runCalls()
    const failed = await h.readCall(call.id)
    expect(failed).toMatchObject({ state: 'failed', failureReason: 'too_many_speakers' })
    expect(failed.speakerLabels).toEqual([])
  })

  test('a transient embedder failure retries, then succeeds, and the retry does not duplicate vectors', async () => {
    const h = await createCallHarness()
    const call = await upload(h, transcriptText('retry', 2))
    const embed = h.deps.embedder.embed.bind(h.deps.embedder)
    let failures = 1
    h.deps.embedder.embed = async (...args) => {
      if (failures-- > 0) {
        throw new Error('model unavailable')
      }
      return embed(...args)
    }

    await h.runCalls()
    expect((await h.readCall(call.id)).state).toBe('processing')
    await h.deps.time.advance(20 * 60 * 1000)
    await h.runCalls()

    expect((await h.readCall(call.id)).state).toBe('ready')
    expect(await vectorsOf(h, call.id)).toHaveLength(2)
  })

  test('the last allowed attempt ends the Call processing_failed', async () => {
    const h = await createCallHarness({ env: { INGESTION_MAX_ATTEMPTS: '1' } })
    const call = await upload(h, transcriptText())
    h.deps.embedder.embed = async () => {
      throw new Error('model unavailable')
    }
    await h.runCalls()
    expect(await h.readCall(call.id)).toMatchObject({
      state: 'failed',
      failureReason: 'processing_failed',
    })
  })

  test('a crash after the vectors were written resumes by overwriting, never duplicating', async () => {
    const h = await createCallHarness()
    const call = await upload(h, transcriptText('crash', 3))
    // The first run writes its vectors, then the completion fails once.
    h.deps.database.failNext(CALL_JOB_COMPLETE, new Error('connection reset'))
    await h.runCalls()
    expect((await h.readCall(call.id)).state).toBe('processing')
    expect(await vectorsOf(h, call.id)).toHaveLength(3)

    await h.deps.time.advance(20 * 60 * 1000)
    await h.runCalls()

    expect((await h.readCall(call.id)).state).toBe('ready')
    expect(await vectorsOf(h, call.id)).toHaveLength(3)
  })

  test('a lease that passed to another claim writes nothing more and fails nothing', async () => {
    const h = await createCallHarness()
    const call = await upload(h, transcriptText())
    const base = h.deps.objects.get.bind(h.deps.objects)
    h.deps.objects.get = async (...args) => {
      const stored = await base(...args)
      const job = h.deps.database.callJobs(h.organizationId)[0]
      if (job !== undefined) {
        job.claim_token = crypto.randomUUID()
      }
      return stored
    }

    await h.runCalls()

    expect(await vectorsOf(h, call.id)).toHaveLength(0)
    expect((await h.readCall(call.id)).state).toBe('processing')
  })

  test('a Call deleted mid-job stops writing, and after the lease the cleanup leaves no vector and no object', async () => {
    for (const when of ['before the vectors', 'after the vectors'] as const) {
      const h = await createCallHarness()
      const call = await upload(h, transcriptText('gone', 2))
      const markDeleted = () => {
        const row = h.deps.database.calls(h.organizationId)[0]
        const job = h.deps.database.callJobs(h.organizationId)[0]
        if (row === undefined || job === undefined) {
          throw new Error('no Call')
        }
        const now = h.deps.clock.now().getTime()
        row.state = 'deleted'
        row.deleted_at = now
        row.deletion_seq += 1
        row.epoch += 1
        row.purge_due_at = now
        job.state = 'cancelled'
        job.next_attempt_at = now + 60_000
      }
      if (when === 'before the vectors') {
        const embed = h.deps.embedder.embed.bind(h.deps.embedder)
        h.deps.embedder.embed = async (...args) => {
          markDeleted()
          return embed(...args)
        }
      } else {
        const upsert = h.deps.vectors.upsert.bind(h.deps.vectors)
        h.deps.vectors.upsert = async (...args) => {
          await upsert(...args)
          markDeleted()
        }
      }

      await h.runCalls()

      // The job stopped: the Call was not completed, and a vector exists only if it was written first.
      expect(h.deps.database.calls(h.organizationId)[0]?.state).toBe('deleted')
      if (when === 'before the vectors') {
        expect(await vectorsOf(h, call.id)).toHaveLength(0)
      }
      await h.deps.time.advance(2 * 60_000)
      await purgeCalls(h.deps, h.organizationId, new AbortController().signal)
      expect(await vectorsOf(h, call.id)).toHaveLength(0)
      expect(await h.objectKeys()).toEqual([])
      expect(h.deps.database.calls(h.organizationId)).toEqual([])
    }
  })

  test('a Deal that becomes won between the tag read and the completion leaves the Call ready but out of search', async () => {
    const h = await createCallHarness()
    const call = await upload(h, transcriptText('race'), { dealId: 'DEAL-R' })
    const embed = h.deps.embedder.embed.bind(h.deps.embedder)
    h.deps.embedder.embed = async (...args) => {
      await h.deps.database.scope(h.organizationId, (run) =>
        run(DEAL_SET_OUTCOME, [
          h.organizationId,
          h.deps.database.deals(h.organizationId)[0]?.id,
          'won',
        ])
      )
      return embed(...args)
    }

    await h.runCalls()

    const ready = await h.readCall(call.id)
    expect(ready).toMatchObject({ state: 'ready', dealOutcome: 'won', inSearch: false })
    // The vectors carry the tag as it was read; only the re-tag job (part two) can repair it.
    expect((await vectorsOf(h, call.id))[0]?.attributes).toMatchObject({ outcome: 'open' })
  })

  test('shutdown gives the job back, due at once', async () => {
    const h = await createCallHarness()
    const call = await upload(h, transcriptText())
    const claimed = await h.deps.database.scope(h.organizationId, (run) =>
      run(CALL_JOB_CLAIM, [h.organizationId, 1, 60_000, null])
    )
    const { jobs } = claimedCallJobs(claimed.rows as never)
    const job = jobs[0]
    expect(job).toBeDefined()

    const outcome = await runCallJob(
      h.deps,
      h.organizationId,
      job as NonNullable<typeof job>,
      AbortSignal.abort(new ShuttingDown())
    )

    expect(outcome).toBe('released')
    expect(h.deps.database.callJobs(h.organizationId)[0]).toMatchObject({ state: 'queued' })
    expect(call.id).toBeDefined()
  })

  test('a second Organization cannot see the vectors and its own Call is untouched', async () => {
    const h = await createCallHarness()
    const call = await upload(h, transcriptText())
    await h.runCalls()
    const other = `org_${'8'.repeat(32)}`
    expect(await vectorsOf(h, call.id, other)).toHaveLength(0)
    const stranger = personIn(other, 'owner')
    expect((await h.send('GET', `${CALLS}/${call.id}`, { as: stranger })).status).toBe(404)
  })

  test('a Deal counts its live Calls: two give 2, a deleted one is not counted, another Organization has its own', async () => {
    const h = await createCallHarness()
    const first = await upload(h, transcriptText('a'), { dealId: 'D-1' })
    await upload(h, transcriptText('b'), { dealId: 'D-1' })
    const other = `org_${'8'.repeat(32)}`
    h.confirmRights(other)
    const stranger = personIn(other, 'owner')
    const theirs = await h.uploadCall(transcriptText('c'), { dealId: 'D-1', as: stranger })
    expect(theirs.status).toBe(201)
    const countOf = async (as?: typeof stranger) => {
      const list = listDealsResponseSchema.parse(
        await (await h.send('GET', '/v1/playbook/deals', as === undefined ? {} : { as })).json()
      )
      const [deal] = list.items
      const detail = dealSchema.parse(
        await (
          await h.send('GET', `/v1/playbook/deals/${deal?.id}`, as === undefined ? {} : { as })
        ).json()
      )
      expect(detail.callCount).toBe(deal?.callCount ?? -1)
      return detail.callCount
    }

    expect(await countOf()).toBe(2)
    expect((await h.send('DELETE', `${CALLS}/${first.id}`)).status).toBe(200)
    expect(await countOf()).toBe(1)
    expect(await countOf(stranger)).toBe(1)
  })

  test('a Transcript the store reports over the cap fails unreadable without being read', async () => {
    const h = await createCallHarness()
    const call = await upload(h, transcriptText('big'), { dealId: 'D-9' })
    const head = h.deps.objects.head.bind(h.deps.objects)
    h.deps.objects.head = async (organizationId, key) => {
      const info = await head(organizationId, key)
      return info === undefined ? info : { ...info, size: 6 * 1024 * 1024 }
    }
    let reads = 0
    h.deps.objects.get = async () => {
      reads++
      throw new Error('get must not be called')
    }

    await h.runCalls()

    expect(await h.readCall(call.id)).toMatchObject({
      state: 'failed',
      failureReason: 'unreadable',
    })
    expect(reads).toBe(0)
  })

  test('each pass claims one job per Organization', async () => {
    const h = await createCallHarness()
    await upload(h, transcriptText('a'), { dealId: 'D-1' })
    await upload(h, transcriptText('b'), { dealId: 'D-2' })
    await upload(h, transcriptText('c'), { dealId: 'D-3' })
    expect(await h.deps.workers.ingestion.runPass()).toBe(1)
    expect(await h.deps.workers.ingestion.runPass()).toBe(1)
    expect(await h.runCalls()).toBe(1)
    const states = (await h.listAll()).map((c: Call) => c.state)
    expect(states.every((state) => state === 'ready')).toBe(true)
  })

  test('logs hold no Transcript text, speaker label or deal id', async () => {
    const h = await createCallHarness()
    const text = `${SECRET_LABEL}: ${SECRET_LINE}\nSam: tell me more about it\n`
    const response = await h.uploadCall(text, {
      dealId: 'ACME-SECRET-DEAL-9',
      rep: JSON.stringify({ by: 'speaker', label: SECRET_LABEL }),
    })
    expect(response.status).toBe(201)
    h.deps.database.failNext(CALL_JOB_COMPLETE, new Error(`broke on ${SECRET_LINE}`))
    await h.runCalls()
    await h.deps.time.advance(20 * 60 * 1000)
    await h.runCalls()

    const everything = [
      ...h.deps.logLines,
      ...h.deps.reported.map((r) => JSON.stringify(r.context)),
    ].join('\n')
    for (const secret of [SECRET_LABEL, 'swordfish', 'ACME-SECRET-DEAL-9', 'call.txt']) {
      expect(everything).not.toContain(secret)
    }
    expect(logged(h.deps, 'a Call job ended').length).toBeGreaterThan(0)
  })
})

describe('the daily embed budget', () => {
  /** Today's Moment total for an Organization, read without adding. */
  async function usedToday(h: CallHarness, org: string = h.organizationId): Promise<number> {
    const result = await h.deps.database.scope(org, (run) => run(EMBED_USAGE_ADD, [org, 0]))
    return Number(result.rows[0]?.moments ?? 0)
  }

  test('a Call counts its embedded Moments against the day and records both counts on the Call', async () => {
    const h = await createCallHarness({ env: { MAX_MOMENTS_PER_CALL: '2' } })
    const call = await upload(h, transcriptText('count', 5))

    await h.runCalls()

    expect(await usedToday(h)).toBe(2)
    expect(h.deps.database.calls(h.organizationId).find((c) => c.id === call.id)).toMatchObject({
      embedded_moments: 2,
      skipped_moments: 3,
    })
  })

  test('a Call over the day budget waits for the next UTC day, embeds nothing and is not counted', async () => {
    const h = await createCallHarness({ env: { EMBED_DAILY_MOMENTS_PER_ORGANIZATION: '3' } })
    const first = await upload(h, transcriptText('one', 3))
    await h.runCalls()
    expect((await h.readCall(first.id)).state).toBe('ready')
    const second = await upload(h, transcriptText('two', 3))
    const embed = spyOn(h.deps.embedder, 'embed')

    await h.runCalls()

    expect((await h.readCall(second.id)).state).toBe('processing')
    expect(embed).not.toHaveBeenCalled()
    expect(await usedToday(h)).toBe(3)
    expect(logged(h.deps, 'a Call waits for the next day of the embed budget')).toHaveLength(1)

    // The day turns: the budget is fresh and the same Call is embedded.
    await h.deps.time.advance(24 * 60 * 60 * 1000)
    await h.deps.time.advance(60 * 60 * 1000)
    await h.runCalls()
    expect((await h.readCall(second.id)).state).toBe('ready')
  })

  test('a Call larger than the whole day budget is still embedded on an empty day', async () => {
    const h = await createCallHarness({ env: { EMBED_DAILY_MOMENTS_PER_ORGANIZATION: '2' } })
    const call = await upload(h, transcriptText('big', 5))

    await h.runCalls()

    expect((await h.readCall(call.id)).state).toBe('ready')
  })

  test('a retried Call is counted once, not once per attempt', async () => {
    const h = await createCallHarness()
    const call = await upload(h, transcriptText('retry', 2))
    const embed = h.deps.embedder.embed.bind(h.deps.embedder)
    let failures = 1
    h.deps.embedder.embed = async (...args) => {
      if (failures-- > 0) {
        throw new Error('model unavailable')
      }
      return embed(...args)
    }

    await h.runCalls()
    expect(await usedToday(h)).toBe(0)
    await h.deps.time.advance(20 * 60 * 1000)
    await h.runCalls()

    expect((await h.readCall(call.id)).state).toBe('ready')
    expect(await usedToday(h)).toBe(2)
  })

  test('another Organization has its own budget', async () => {
    const h = await createCallHarness({ env: { EMBED_DAILY_MOMENTS_PER_ORGANIZATION: '3' } })
    await upload(h, transcriptText('mine', 3))
    await h.runCalls()

    expect(await usedToday(h)).toBe(3)
    expect(await usedToday(h, 'org_00000000000000000000000000000000')).toBe(0)
  })

  test('the purge removes at most the batch and never today', async () => {
    const h = await createCallHarness()
    const org = h.organizationId
    const run = (text: string, params: unknown[]) =>
      h.deps.database.scope(org, (r) => r(text, params))
    for (let day = 0; day < 4; day++) {
      await run(EMBED_USAGE_ADD, [org, 1])
      await h.deps.time.advance(24 * 60 * 60 * 1000)
    }
    await run(EMBED_USAGE_ADD, [org, 1])

    const first = await run(EMBED_USAGE_PURGE, [org, 1, 2])
    const second = await run(EMBED_USAGE_PURGE, [org, 1, 100])
    const third = await run(EMBED_USAGE_PURGE, [org, 1, 100])

    expect(first.rowCount).toBe(2)
    expect(second.rowCount).toBe(1)
    expect(third.rowCount).toBe(0)
    expect(await usedToday(h)).toBe(1)
  })
})
