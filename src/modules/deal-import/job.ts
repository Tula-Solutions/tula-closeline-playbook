import {
  checkDealImportHeader,
  checkDealImportRow,
  type DealImportFailureReason,
  dealIdSchema,
  formatId,
  isBlankCsvRecord,
  MAX_DEAL_IMPORT_BYTES,
  organizationIdSchema,
  type ParsedDealImportRow,
  parseCsv,
} from 'tula-closeline-contract'
import {
  DEAL_IMPORT_APPLY,
  DEAL_IMPORT_APPLY_BATCH,
  DEAL_IMPORT_FAIL,
  DEAL_IMPORT_FINISH,
  DEAL_IMPORT_HEARTBEAT,
  DEAL_IMPORT_RETRY,
  QUOTA_LOCK,
} from 'tula-closeline-db'
import { isLockTimeout } from '~/adapters/postgres/retry'
import { publishOutcomeChanged } from '~/modules/deal/service'
import {
  ClaimLost,
  inTransaction,
  isCancellation,
  jittered,
  type PipelineDeps,
  reportWorkerError,
  retryDelayMs,
  ShuttingDown,
  within,
} from '~/modules/ingestion/runtime'

/** One import this instance has claimed, as `DEAL_IMPORT_CLAIM` returned it. */
export type ClaimedImport = {
  id: string
  objectKey: string
  attempts: number
  token: string
  /** The report's highest row number when this claim began; the run resumes after it. */
  reportThrough: number
}

/** Reads the claimed imports out of the claim statement's rows. */
export function claimedImports(rows: readonly Record<string, unknown>[]): ClaimedImport[] {
  return rows.map((row) => ({
    id: String(row.id),
    objectKey: String(row.object_key),
    attempts: Number(row.attempts),
    token: String(row.claim_token),
    reportThrough: row.last_row_number === null ? 1 : Number(row.last_row_number),
  }))
}

/** How an import's run ended. */
export type ImportOutcome =
  /** Every row was decided and the import is `completed`. */
  | 'completed'
  /** The import ended `failed` with a reason. */
  | 'failed'
  /** A transient failure; the import is due again after a delay. */
  | 'retried'
  /** The claim was lost (the import was erased, or the lease lapsed); nothing more was written. */
  | 'lost'
  /** Shutdown: the import was given back and is due at once. */
  | 'released'
  /** The database could not be told how it ended; the lease lapses and the import is claimed again. */
  | 'uncertain'

/** A file that cannot be imported by trying again: it ends `failed` with this reason. */
class ImportFailure extends Error {
  constructor(readonly reason: DealImportFailureReason) {
    super(`the Deal import failed: ${reason}`)
    this.name = 'ImportFailure'
  }
}

/** The most rows one apply statement takes, the database's own bound. */
export const APPLY_BATCH_ROWS = DEAL_IMPORT_APPLY_BATCH

/** The statement an apply transaction starts with: waiting for the Organization's upload lock for long would hold a connection. */
const APPLY_LOCK_TIMEOUT_SQL = "set local lock_timeout = '3s'"

/** The times a batch is tried again after waiting too long for the upload lock, before the run counts as failed. */
const LOCK_WAIT_ATTEMPTS = 6

/** What every step of one run needs. */
type ImportContext = {
  deps: PipelineDeps
  organizationId: string
  importId: string
  token: string
  /** Aborts on shutdown or on a lost claim: pass it to every call. */
  signal: AbortSignal
  lost: AbortController
}

/** Renews the lease once; false means the claim is gone. */
async function heartbeatOnce(c: ImportContext): Promise<boolean> {
  const { deps } = c
  const result = await inTransaction(deps, c.organizationId, (run) =>
    run(DEAL_IMPORT_HEARTBEAT, [c.organizationId, c.importId, c.token, deps.env.INGESTION_LEASE_MS])
  )
  return result.rows.length > 0
}

/** Confirms the claim is alive right now; throws {@link ClaimLost} (and stops every call) when it is not. */
async function beat(c: ImportContext): Promise<void> {
  c.signal.throwIfAborted()
  if (!(await heartbeatOnce(c))) {
    c.lost.abort(new ClaimLost())
    throw new ClaimLost()
  }
}

/** Renews the lease on a timer while the run works; a quiet database for most of a lease ends the run. */
function startHeartbeat(c: ImportContext): { stop: () => Promise<void> } {
  const { deps } = c
  const control = new AbortController()
  let lastOk = deps.clock.now().getTime()
  const loop = (async () => {
    while (!control.signal.aborted) {
      await deps.sleep(deps.env.INGESTION_HEARTBEAT_MS, control.signal)
      if (control.signal.aborted) {
        return
      }
      try {
        if (await heartbeatOnce(c)) {
          lastOk = deps.clock.now().getTime()
        } else {
          c.lost.abort(new ClaimLost())
          return
        }
      } catch (error) {
        deps.logger.warn('an import heartbeat failed', {
          organizationId: c.organizationId,
          importId: c.importId,
          error: error instanceof Error ? error.name : 'unknown',
        })
        const quiet = deps.clock.now().getTime() - lastOk
        if (quiet >= deps.env.INGESTION_LEASE_MS - deps.env.INGESTION_HEARTBEAT_MS) {
          c.lost.abort(new ClaimLost())
          return
        }
      }
    }
  })()
  return {
    stop: async () => {
      control.abort()
      await loop
    },
  }
}

/** A turn of the event loop, so a long import never starves the heartbeat or other requests. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

/** The CSV, parsed: the records after the header with trailing blank records dropped, and whether the header has `name`. */
export type ParsedFile = { records: string[][]; hasName: boolean }

/**
 * Parses the CSV's bytes with the contract's bounded reader. The reader needs the whole text (at
 * most 10 MB), so this holds the file and its records once; they are released as batches are
 * applied. A file that is not UTF-8, has a quoting error or a cell over the limit is `unreadable`;
 * more records than the limit is `too_many_rows`; a header that is wrong (which the upload route
 * checks on a prefix, and a deferred one only here) is `unreadable`.
 */
export function parseImportFile(body: Uint8Array): ParsedFile {
  if (body.byteLength > MAX_DEAL_IMPORT_BYTES) {
    throw new ImportFailure('unreadable')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body)
  } catch {
    throw new ImportFailure('unreadable')
  }
  const parsed = parseCsv(text)
  if (!parsed.ok) {
    throw new ImportFailure(parsed.failure === 'too_many_records' ? 'too_many_rows' : 'unreadable')
  }
  const [header, ...records] = parsed.records
  const checked = header === undefined ? undefined : checkDealImportHeader(header)
  if (checked === undefined || !checked.ok) {
    throw new ImportFailure('unreadable')
  }
  // A blank line is a record the report cannot hold (it must be contiguous), so blank records at
  // the end are not rows at all; one in the middle is reported as a row with the wrong column count.
  while (records.length > 0 && isBlankCsvRecord(records[records.length - 1] ?? [''])) {
    records.pop()
  }
  return { records, hasName: checked.hasName }
}

/** Reads the claimed import's object and parses it. */
async function readFile(c: ImportContext, objectKey: string): Promise<ParsedFile> {
  const { deps } = c
  const object = await within(
    deps,
    'object store',
    deps.env.INGESTION_IO_TIMEOUT_MS,
    c.signal,
    () => deps.objects.get(c.organizationId, objectKey)
  )
  if (object === undefined) {
    // The upload stores the file before it inserts the row, so a row without a file is a loss.
    throw new ImportFailure('processing_failed')
  }
  return parseImportFile(object.body)
}

/** One row as the apply statement reads it (`jsonb_to_recordset`). */
export type SentRow = {
  row_number: number
  deal_id: string | null
  reason: string | null
  outcome: ParsedDealImportRow['outcome'] | null
  closed_at: string | null
  amount: string | null
  currency: string | null
  name: string | null
}

/** The deal id of a rejected row, when its cell was a valid one (every problem but the id's own and a wrong cell count). */
function dealIdOfRejected(cells: readonly string[], reason: string): string | null {
  if (reason === 'wrong_column_count' || reason === 'invalid_deal_id') {
    return null
  }
  const parsed = dealIdSchema.safeParse(cells[0] ?? '')
  return parsed.success ? parsed.data : null
}

/** Judges one record with the contract's row check; the result carries the deal id and the parsed cells, never the raw record. */
export function judge(rowNumber: number, cells: readonly string[], hasName: boolean): SentRow {
  if (isBlankCsvRecord(cells)) {
    return blank(rowNumber, 'wrong_column_count', null)
  }
  const checked = checkDealImportRow(cells, hasName)
  if (!checked.ok) {
    return blank(rowNumber, checked.reason, dealIdOfRejected(cells, checked.reason))
  }
  const row = checked.row
  return {
    row_number: rowNumber,
    deal_id: row.dealId,
    reason: null,
    outcome: row.outcome,
    closed_at: row.closedAt,
    amount: row.amount,
    currency: row.currency,
    name: row.name,
  }
}

/** A row that carries only a reason. */
function blank(rowNumber: number, reason: string, dealId: string | null): SentRow {
  return {
    row_number: rowNumber,
    deal_id: dealId,
    reason,
    outcome: null,
    closed_at: null,
    amount: null,
    currency: null,
    name: null,
  }
}

/** What one apply statement answered. */
type Applied = {
  taken: number
  through: number
  changed: { dealRecordId: string; outcomeSeq: number }[]
}

/**
 * Applies one batch in one transaction that takes the Organization's upload lock first, as the
 * statement requires. A wait that runs into the lock timeout is tried again after a jittered pause,
 * a bounded number of times: it is contention, not a failure of the import.
 */
async function applyBatch(c: ImportContext, rows: readonly SentRow[]): Promise<Applied> {
  const { deps } = c
  const payload = JSON.stringify(rows)
  for (let attempt = 1; ; attempt++) {
    c.signal.throwIfAborted()
    try {
      const result = await inTransaction(deps, c.organizationId, async (run) => {
        await run(APPLY_LOCK_TIMEOUT_SQL, [])
        await run(QUOTA_LOCK, [c.organizationId])
        return run(DEAL_IMPORT_APPLY, [
          c.organizationId,
          c.importId,
          c.token,
          payload,
          deps.env.MAX_DEALS_PER_ORGANIZATION,
          APPLY_BATCH_ROWS,
        ])
      })
      const summary = result.rows.find((row) => row.kind === 'summary')
      if (summary === undefined) {
        // The statement found no import held by this claim: it was erased or the lease passed on.
        c.lost.abort(new ClaimLost())
        throw new ClaimLost()
      }
      if (summary.refusal !== null && summary.refusal !== undefined) {
        // The service numbers rows itself, so a refusal is a bug, never the file's fault.
        throw new Error(`the apply statement refused the batch: ${String(summary.refusal)}`)
      }
      return {
        taken: Number(summary.taken),
        through: Number(summary.through),
        changed: result.rows
          .filter((row) => row.kind === 'outcome_changed')
          .map((row) => ({
            dealRecordId: String(row.deal_record_id),
            outcomeSeq: Number(row.outcome_seq),
          })),
      }
    } catch (error) {
      if (!isLockTimeout(error) || attempt >= LOCK_WAIT_ATTEMPTS) {
        throw error
      }
      deps.logger.debug('an import batch waited too long for the upload lock', {
        organizationId: c.organizationId,
        importId: c.importId,
        attempt,
      })
      await deps.sleep(jittered(deps, 250 * 2 ** (attempt - 1)), c.signal)
    }
  }
}

/** Reads the file and applies it in batches from where the report stands, then finishes with the true row count. */
async function runBatches(c: ImportContext, claim: ClaimedImport): Promise<number> {
  const { deps } = c
  const file = await readFile(c, claim.objectKey)
  const count = file.records.length
  let through = claim.reportThrough
  // Row numbers: the header is record 1, so the first data row is 2 and the last is count + 1.
  while (through < count + 1) {
    await beat(c)
    const first = through + 1
    const last = Math.min(through + APPLY_BATCH_ROWS, count + 1)
    const rows: SentRow[] = []
    for (let rowNumber = first; rowNumber <= last; rowNumber++) {
      rows.push(judge(rowNumber, file.records[rowNumber - 2] ?? [''], file.hasName))
    }
    const applied = await applyBatch(c, rows)
    if (applied.taken !== rows.length || applied.through !== last) {
      throw new Error('the apply statement took a different number of rows than were sent')
    }
    // Only now is the batch behind us: its records are not needed again by this run.
    for (let rowNumber = first; rowNumber <= last; rowNumber++) {
      file.records[rowNumber - 2] = []
    }
    through = applied.through
    for (const change of applied.changed) {
      await publishOutcomeChanged(
        deps,
        {
          organizationId: organizationIdSchema.parse(c.organizationId),
          requestId: formatId('req', crypto.randomUUID()),
        },
        change.dealRecordId,
        change.outcomeSeq
      )
    }
    await yieldToEventLoop()
  }
  return count
}

/**
 * Runs one claimed import to its end. The run resumes after `report_through`, so a crash or a
 * redelivery never applies a row twice (the statement skips rows at or below it). Every end state
 * removes the CSV from the object store, best effort; the orphan sweep removes what this misses.
 * Nothing it logs holds a file name, a cell or a deal id: ids, counts and durations only.
 */
export async function runImport(
  deps: PipelineDeps,
  organizationId: string,
  claim: ClaimedImport,
  shutdown: AbortSignal
): Promise<ImportOutcome> {
  const started = deps.clock.now().getTime()
  const lost = new AbortController()
  const context: ImportContext = {
    deps,
    organizationId,
    importId: claim.id,
    token: claim.token,
    signal: AbortSignal.any([shutdown, lost.signal]),
    lost,
  }
  const heartbeat = startHeartbeat(context)
  let outcome: ImportOutcome
  let rows = 0
  try {
    rows = await runBatches(context, claim)
    const finished = await inTransaction(deps, organizationId, (run) =>
      run(DEAL_IMPORT_FINISH, [organizationId, claim.id, claim.token, rows])
    )
    if (finished.rows.length === 0) {
      // The claim passed on, or the report does not reach the row count: either way nothing is written.
      deps.logger.warn('an import could not be finished', {
        organizationId,
        importId: claim.id,
        rows,
      })
      outcome = 'lost'
    } else {
      outcome = 'completed'
      await removeObject(context, claim.objectKey)
    }
  } catch (error) {
    outcome = await settle(context, claim, error, shutdown)
  } finally {
    await heartbeat.stop()
  }
  deps.logger.info('a Deal import run ended', {
    organizationId,
    importId: claim.id,
    outcome,
    attempts: claim.attempts,
    rows,
    durationMs: deps.clock.now().getTime() - started,
  })
  return outcome
}

/** Removes the import's CSV after the import ended; a failure is logged and left to the orphan sweep. */
async function removeObject(c: ImportContext, objectKey: string): Promise<void> {
  const { deps } = c
  try {
    await within(
      deps,
      'object store',
      deps.env.INGESTION_IO_TIMEOUT_MS,
      new AbortController().signal,
      () => deps.objects.delete(c.organizationId, objectKey)
    )
  } catch (error) {
    deps.logger.warn('the CSV of an ended import could not be removed; the orphan sweep will', {
      organizationId: c.organizationId,
      importId: c.importId,
      error: error instanceof Error ? error.name : 'unknown',
    })
  }
}

/** Decides what a failed run means for the import and records it. */
async function settle(
  c: ImportContext,
  claim: ClaimedImport,
  error: unknown,
  shutdown: AbortSignal
): Promise<ImportOutcome> {
  const { deps } = c
  try {
    if (c.lost.signal.aborted || error instanceof ClaimLost) {
      return 'lost'
    }
    if (shutdown.aborted || error instanceof ShuttingDown) {
      const released = await inTransaction(deps, c.organizationId, (run) =>
        run(DEAL_IMPORT_RETRY, [c.organizationId, c.importId, c.token, 0])
      )
      return released.rows.length > 0 ? 'released' : 'lost'
    }
    if (isCancellation(error)) {
      return 'lost'
    }
    const permanent = error instanceof ImportFailure ? error.reason : undefined
    if (permanent !== undefined || claim.attempts >= deps.env.INGESTION_MAX_ATTEMPTS) {
      const reason: DealImportFailureReason = permanent ?? 'processing_failed'
      if (permanent === undefined) {
        reportWorkerError(deps, error, { worker: 'imports', organizationId: c.organizationId })
      }
      const failed = await inTransaction(deps, c.organizationId, (run) =>
        run(DEAL_IMPORT_FAIL, [c.organizationId, c.importId, c.token, reason])
      )
      deps.logger.info('a Deal import failed', {
        organizationId: c.organizationId,
        importId: c.importId,
        reason,
      })
      if (failed.rows.length === 0) {
        return 'lost'
      }
      await removeObject(c, claim.objectKey)
      return 'failed'
    }
    deps.logger.warn('a Deal import attempt failed; it will be retried', {
      organizationId: c.organizationId,
      importId: c.importId,
      attempts: claim.attempts,
      error: error instanceof Error ? error.name : 'unknown',
    })
    const retried = await inTransaction(deps, c.organizationId, (run) =>
      run(DEAL_IMPORT_RETRY, [
        c.organizationId,
        c.importId,
        c.token,
        retryDelayMs(deps, claim.attempts),
      ])
    )
    return retried.rows.length > 0 ? 'retried' : 'lost'
  } catch (settleError) {
    // The database could not be told: the lease lapses and the import is claimed again.
    reportWorkerError(deps, settleError, { worker: 'imports', organizationId: c.organizationId })
    return 'uncertain'
  }
}
