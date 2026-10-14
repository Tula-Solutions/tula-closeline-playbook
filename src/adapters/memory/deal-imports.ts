import {
  DEAL_IMPORT_APPLY,
  DEAL_IMPORT_APPLY_BATCH,
  DEAL_IMPORT_CLAIM,
  DEAL_IMPORT_ERASE_BATCH,
  DEAL_IMPORT_FAIL,
  DEAL_IMPORT_FINISH,
  DEAL_IMPORT_GET,
  DEAL_IMPORT_GIVE_UP_SPENT,
  DEAL_IMPORT_HEARTBEAT,
  DEAL_IMPORT_INSERT,
  DEAL_IMPORT_LIST,
  DEAL_IMPORT_LIST_ERASED,
  DEAL_IMPORT_MAX_ATTEMPTS,
  DEAL_IMPORT_OBJECT_REMOVED,
  DEAL_IMPORT_PURGE_BATCH,
  DEAL_IMPORT_RETRY,
  DEAL_IMPORT_ROWS_LIST,
  DEAL_IMPORT_ROWS_LIST_BY_RESULT,
  DEAL_MAX_SEQ,
  PLAYBOOK_MIN_LEASE_MS,
} from 'tula-closeline-db'
import type { Result } from '~/adapters/postgres/processed-store'

/** One row of `playbook.deal_imports`. Times are milliseconds except `created_at_us`. */
export type MemoryImportRow = {
  id: string
  organization_id: string
  uploaded_by: string
  object_key: string
  size_bytes: number
  state: 'uploaded' | 'processing' | 'completed' | 'failed'
  failure_reason: string | null
  attempts: number
  next_attempt_at: number
  claim_token: string | null
  /** The highest report row number; 1 (the header) until a batch is applied. */
  report_through: number
  applied_count: number
  rejected_count: number
  row_count: number | null
  object_removed_at: number | null
  erased_at: number | null
  finished_at: number | null
  created_at_us: number
  updated_at: number
}

/** One row of `playbook.deal_import_rows`: the report, and nothing else of the CSV row. */
export type MemoryImportReportRow = {
  organization_id: string
  import_id: string
  row_number: number
  deal_id: string | null
  result: 'applied' | 'rejected'
  reason: string | null
}

/** The Deal rows of the double, as the apply statement reads and writes them. */
export type MemoryApplyDeal = {
  id: string
  organization_id: string
  deal_id: string
  name: string | null
  outcome: 'won' | 'lost' | 'open'
  outcome_seq: number
  closed_at: number | null
  amount: string | null
  currency: string | null
  appeared_in_import: boolean
  created_at_us: number
  updated_at: number
}

/** What the import statements need from the double they run in. */
export type ImportContext = {
  imports: MemoryImportRow[]
  importRows: MemoryImportReportRow[]
  deals: MemoryApplyDeal[]
  /** Whether the statement runs in `organization`'s scope. */
  own(organization: unknown): boolean
  /** Whether this transaction has taken the Organization's upload lock (`QUOTA_LOCK`). */
  uploadLockHeld(): boolean
  now(): number
  /** A strictly increasing microsecond clock for `created_at`. */
  nextMicroseconds(): number
  rows(list: readonly unknown[]): Result
  none: Result
  batch(value: unknown, max: number): number
  pgTimestamp(ms: number): string
  pgTimestampUs(us: number): string
  cursorMicroseconds(text: unknown): number
  postgresError(code: string, message?: string): Error
}

/** A `numeric(17,2)` as Postgres prints it: two fraction digits. */
function numeric2(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }
  const [whole = '0', fraction = ''] = String(value).split('.')
  return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`
}

/** One batch row as the statement's `jsonb_to_recordset` reads it. */
type SentRow = {
  row_number: number
  deal_id: string | null
  reason: string | null
  outcome: 'won' | 'lost' | 'open' | null
  closed_at: string | null
  amount: unknown
  currency: string | null
  name: string | null
}

const MAX_ROW_NUMBER = 50_001

/**
 * Runs one Deal import statement of the db library against the double, with the rules the README
 * states, or returns `undefined` for any other statement. Only a transaction scoped to the
 * statement's Organization sees its rows.
 */
export function runImportStatement(
  text: string,
  params: readonly unknown[],
  ctx: ImportContext
): Result | undefined {
  const { rows, none, own, now, batch } = ctx
  const mine = (organization: unknown) =>
    ctx.imports.filter((i) => own(organization) && i.organization_id === organization)
  const find = (organization: unknown, id: unknown) =>
    mine(organization).find((i) => i.id === id && i.erased_at === null)
  const holder = (organization: unknown, id: unknown, token: unknown) => {
    const found = find(organization, id)
    return found !== undefined && found.state === 'processing' && found.claim_token === token
      ? found
      : undefined
  }
  const view = (i: MemoryImportRow) => ({
    id: i.id,
    state: i.state,
    failure_reason: i.failure_reason,
    row_count: i.state === 'completed' ? i.row_count : null,
    applied_count: i.state === 'completed' ? i.applied_count : null,
    rejected_count: i.state === 'completed' ? i.rejected_count : null,
    uploaded_by: i.uploaded_by,
    created_at: ctx.pgTimestampUs(i.created_at_us),
    updated_at: ctx.pgTimestamp(i.updated_at),
  })
  const touch = (i: MemoryImportRow) => {
    i.updated_at = now()
  }

  switch (text) {
    case DEAL_IMPORT_INSERT: {
      const [organization, id, by, objectKey, size] = params as [
        string,
        string,
        string,
        string,
        number,
      ]
      if (!own(organization)) {
        return none
      }
      const at = now()
      const row: MemoryImportRow = {
        id,
        organization_id: organization,
        uploaded_by: by,
        object_key: objectKey,
        size_bytes: Number(size),
        state: 'uploaded',
        failure_reason: null,
        attempts: 0,
        next_attempt_at: at,
        claim_token: null,
        report_through: 1,
        applied_count: 0,
        rejected_count: 0,
        row_count: null,
        object_removed_at: null,
        erased_at: null,
        finished_at: null,
        created_at_us: ctx.nextMicroseconds(),
        updated_at: at,
      }
      ctx.imports.push(row)
      return rows([view(row)])
    }
    case DEAL_IMPORT_GET: {
      const [organization, id] = params as [string, string]
      const found = find(organization, id)
      return found === undefined ? none : rows([view(found)])
    }
    case DEAL_IMPORT_LIST: {
      const [organization, createdAfter, idAfter, size] = params as [
        string,
        string,
        string,
        number | null,
      ]
      const after = ctx.cursorMicroseconds(createdAfter)
      const page = mine(organization)
        .filter((i) => i.erased_at === null)
        .filter(
          (i) =>
            after === Number.POSITIVE_INFINITY ||
            i.created_at_us < after ||
            (i.created_at_us === after && i.id < idAfter)
        )
        .sort((a, b) =>
          a.created_at_us === b.created_at_us
            ? a.id < b.id
              ? 1
              : -1
            : a.created_at_us < b.created_at_us
              ? 1
              : -1
        )
        .slice(0, batch(size, 100))
      return rows(page.map((i) => ({ ...view(i), cursor_at: ctx.pgTimestampUs(i.created_at_us) })))
    }
    case DEAL_IMPORT_CLAIM: {
      const [organization, size, leaseMs] = params as [string, number, number]
      const due = mine(organization)
        .filter(
          (i) =>
            (i.state === 'uploaded' || i.state === 'processing') &&
            i.erased_at === null &&
            i.attempts < DEAL_IMPORT_MAX_ATTEMPTS &&
            i.next_attempt_at <= now()
        )
        .sort((a, b) => a.next_attempt_at - b.next_attempt_at)
        .slice(0, batch(size, 500))
      for (const i of due) {
        i.state = 'processing'
        i.attempts += 1
        i.claim_token = crypto.randomUUID()
        i.next_attempt_at = now() + Math.max(Number(leaseMs) || 0, PLAYBOOK_MIN_LEASE_MS)
        touch(i)
      }
      return rows(
        due.map((i) => ({
          id: i.id,
          object_key: i.object_key,
          size_bytes: i.size_bytes,
          attempts: i.attempts,
          claim_token: i.claim_token,
          last_row_number: i.report_through > 1 ? i.report_through : null,
        }))
      )
    }
    case DEAL_IMPORT_HEARTBEAT: {
      const [organization, id, token, leaseMs] = params as [string, string, string, number]
      const i = holder(organization, id, token)
      if (i === undefined) {
        return none
      }
      i.next_attempt_at = now() + Math.max(Number(leaseMs) || 0, PLAYBOOK_MIN_LEASE_MS)
      touch(i)
      return rows([{ id }])
    }
    case DEAL_IMPORT_RETRY: {
      const [organization, id, token, delayMs] = params as [string, string, string, number]
      const i = holder(organization, id, token)
      if (i === undefined) {
        return none
      }
      i.state = 'uploaded'
      i.claim_token = null
      i.next_attempt_at = now() + Math.min(Math.max(Number(delayMs) || 0, 0), 3_600_000)
      touch(i)
      return rows([{ id, attempts: i.attempts }])
    }
    case DEAL_IMPORT_FAIL: {
      const [organization, id, token, reason] = params as [string, string, string, string]
      const i = holder(organization, id, token)
      if (i === undefined) {
        return none
      }
      if (!['too_many_rows', 'unreadable', 'processing_failed'].includes(reason)) {
        throw ctx.postgresError('23514', 'deal_imports_failure_reason_known')
      }
      i.state = 'failed'
      i.failure_reason = reason
      i.claim_token = null
      i.object_removed_at = now()
      i.finished_at = now()
      touch(i)
      return rows([{ id }])
    }
    case DEAL_IMPORT_FINISH: {
      const [organization, id, token, count] = params as [string, string, string, number]
      const i = holder(organization, id, token)
      if (i === undefined || i.report_through !== Number(count) + 1) {
        return none
      }
      i.state = 'completed'
      i.claim_token = null
      i.row_count = i.applied_count + i.rejected_count
      i.object_removed_at = now()
      i.finished_at = now()
      touch(i)
      return rows([
        {
          id,
          row_count: i.row_count,
          applied_count: i.applied_count,
          rejected_count: i.rejected_count,
        },
      ])
    }
    case DEAL_IMPORT_GIVE_UP_SPENT: {
      const [organization, size] = params as [string, number]
      const spent = mine(organization)
        .filter(
          (i) =>
            (i.state === 'uploaded' || i.state === 'processing') &&
            i.erased_at === null &&
            i.attempts >= DEAL_IMPORT_MAX_ATTEMPTS &&
            i.next_attempt_at <= now()
        )
        .slice(0, batch(size, 500))
      return rows(
        spent.map((i) => {
          i.state = 'failed'
          i.failure_reason = 'processing_failed'
          i.claim_token = null
          i.finished_at = now()
          touch(i)
          return { id: i.id, object_key: i.object_key }
        })
      )
    }
    case DEAL_IMPORT_OBJECT_REMOVED: {
      const [organization, id] = params as [string, string]
      const i = mine(organization).find((x) => x.id === id)
      if (i === undefined || (i.erased_at === null && i.state !== 'failed')) {
        return none
      }
      i.object_removed_at ??= now()
      touch(i)
      return rows([{ id }])
    }
    case DEAL_IMPORT_ROWS_LIST:
    case DEAL_IMPORT_ROWS_LIST_BY_RESULT: {
      const [organization, id, after, size, result] = params as [
        string,
        string,
        number,
        number,
        string | undefined,
      ]
      const page = ctx.importRows
        .filter(
          (r) =>
            own(organization) &&
            r.organization_id === organization &&
            r.import_id === id &&
            r.row_number > after &&
            (text === DEAL_IMPORT_ROWS_LIST || r.result === result)
        )
        .sort((a, b) => a.row_number - b.row_number)
        .slice(0, batch(size, 100))
      return rows(
        page.map((r) => ({
          row_number: r.row_number,
          deal_id: r.deal_id,
          result: r.result,
          reason: r.reason,
        }))
      )
    }
    case DEAL_IMPORT_ERASE_BATCH: {
      const [organization, size] = params as [string, number]
      const batchOf = mine(organization)
        .filter((i) => i.erased_at === null)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, batch(size, 500))
      return rows(
        batchOf.map((i) => {
          if (i.state === 'uploaded' || i.state === 'processing') {
            i.state = 'failed'
            i.failure_reason = 'processing_failed'
          }
          i.finished_at ??= now()
          i.claim_token = null
          i.erased_at = now()
          touch(i)
          return {
            id: i.id,
            object_key: i.object_key,
            object_pending: i.object_removed_at === null,
          }
        })
      )
    }
    case DEAL_IMPORT_LIST_ERASED: {
      const [organization, idAfter, size] = params as [string, string, number | null]
      return rows(
        mine(organization)
          .filter((i) => i.erased_at !== null && i.id > idAfter)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .slice(0, batch(size, 100))
          .map((i) => ({
            id: i.id,
            object_key: i.object_key,
            object_pending: i.object_removed_at === null,
          }))
      )
    }
    case DEAL_IMPORT_PURGE_BATCH: {
      const [organization, id, size] = params as [string, string, number]
      const i = mine(organization).find((x) => x.id === id)
      if (i === undefined || i.erased_at === null || i.object_removed_at === null) {
        return none
      }
      const mineRows = ctx.importRows
        .filter((r) => r.organization_id === organization && r.import_id === id)
        .sort((a, b) => a.row_number - b.row_number)
      const doomed = new Set(mineRows.slice(0, batch(size, 500)))
      // Rows are immutable once written, so the array is replaced, never edited in place.
      ctx.importRows.splice(
        0,
        ctx.importRows.length,
        ...ctx.importRows.filter((r) => !doomed.has(r))
      )
      const left = ctx.importRows.some(
        (r) => r.organization_id === organization && r.import_id === id
      )
      if (!left) {
        ctx.imports.splice(ctx.imports.indexOf(i), 1)
      }
      return rows([{ deleted_rows: doomed.size, import_deleted: !left }])
    }
    case DEAL_IMPORT_APPLY:
      return applyBatch(params, ctx, { find: holder, mine })
    default:
      return undefined
  }
}

/** The apply statement: one bounded batch, decided in row order, the report written and the counts moved together. */
function applyBatch(
  params: readonly unknown[],
  ctx: ImportContext,
  lookup: {
    find: (organization: unknown, id: unknown, token: unknown) => MemoryImportRow | undefined
    mine: (organization: unknown) => MemoryImportRow[]
  }
): Result {
  const [organization, id, token, json, dealLimit, size] = params as [
    string,
    string,
    string,
    string,
    number,
    number,
  ]
  const imp = lookup.find(organization, id, token)
  if (imp === undefined) {
    return ctx.none
  }
  if (!ctx.uploadLockHeld()) {
    // What `playbook.require_upload_lock` raises for a row the statement is about to write.
    throw ctx.postgresError(
      '55000',
      'playbook.upload_lock: the Organization upload lock is not held'
    )
  }
  const raw = JSON.parse(json) as Partial<SentRow>[]
  if (!Array.isArray(raw)) {
    throw ctx.postgresError('22023', 'cannot extract elements from a non-array')
  }
  const summary = (taken: number, applied: number, rejected: number, refusal: string | null) => ({
    kind: 'summary',
    deal_record_id: null,
    outcome_seq: null,
    taken,
    applied,
    rejected,
    through: imp.report_through,
    refusal,
  })
  for (const r of raw) {
    if (!Number.isInteger(r.row_number)) {
      if (r.row_number === undefined || r.row_number === null) {
        return ctx.rows([summary(0, 0, 0, 'row_number_range')])
      }
      throw ctx.postgresError('22P02', 'invalid input syntax for type integer')
    }
  }
  const numbers = raw.map((r) => r.row_number as number)
  if (numbers.some((n) => n < 2 || n > MAX_ROW_NUMBER)) {
    return ctx.rows([summary(0, 0, 0, 'row_number_range')])
  }
  if (new Set(numbers).size !== numbers.length) {
    return ctx.rows([summary(0, 0, 0, 'row_number_repeated')])
  }
  // Only the rows numbered report_through + 1, + 2, ... with no gap, at most one batch of them.
  const sent = (raw as SentRow[])
    .filter((r) => r.row_number > imp.report_through)
    .sort((a, b) => a.row_number - b.row_number)
  const taken: SentRow[] = []
  for (const r of sent) {
    if (r.row_number !== imp.report_through + 1 + taken.length) {
      break
    }
    taken.push(r)
    if (taken.length >= ctx.batch(size, DEAL_IMPORT_APPLY_BATCH)) {
      break
    }
  }

  const known = new Map<string, MemoryApplyDeal>()
  for (const d of ctx.deals) {
    if (d.organization_id === organization) {
      known.set(d.deal_id, d)
    }
  }
  const seenBefore = new Set(
    ctx.importRows
      .filter(
        (r) =>
          r.organization_id === organization &&
          r.import_id === id &&
          r.reason !== 'duplicate_in_file' &&
          r.deal_id !== null
      )
      .map((r) => r.deal_id as string)
  )
  const seenInBatch = new Set<string>()
  const existing = ctx.deals.filter((d) => d.organization_id === organization).length
  let candidates = 0
  const report: MemoryImportReportRow[] = []
  const changed: { id: string; seq: number }[] = []

  for (const r of taken) {
    let bad: string | null = null
    const dealId = r.deal_id
    const deal = dealId === null ? undefined : known.get(dealId)
    if (dealId !== null && (seenInBatch.has(dealId) || seenBefore.has(dealId))) {
      bad = 'duplicate_in_file'
    } else if (r.reason !== null && r.reason !== undefined) {
      bad = r.reason
    } else if (deal !== undefined && deal.outcome !== 'open') {
      bad = 'outcome_already_decided'
    }
    if (dealId !== null) {
      seenInBatch.add(dealId)
    }
    if (bad === null && deal === undefined) {
      candidates += 1
      if (existing + candidates > Number(dealLimit)) {
        bad = 'deal_limit_reached'
      }
    }
    if (bad === null && dealId !== null && r.outcome !== null) {
      const closed = r.closed_at === null ? null : Date.parse(r.closed_at)
      if (deal === undefined) {
        const created: MemoryApplyDeal = {
          id: `deal_${crypto.randomUUID().replaceAll('-', '')}`,
          organization_id: organization,
          deal_id: dealId,
          name: r.name,
          outcome: r.outcome,
          outcome_seq: 0,
          closed_at: closed,
          amount: numeric2(r.amount),
          currency: r.currency,
          appeared_in_import: true,
          created_at_us: ctx.nextMicroseconds(),
          updated_at: ctx.now(),
        }
        ctx.deals.push(created)
        known.set(dealId, created)
      } else {
        const nextClosed = closed ?? deal.closed_at
        const moves = r.outcome !== deal.outcome || nextClosed !== deal.closed_at
        if (moves && deal.outcome_seq >= DEAL_MAX_SEQ) {
          throw ctx.postgresError('23514', 'deals_outcome_seq_ceiling')
        }
        deal.outcome = r.outcome
        deal.closed_at = nextClosed
        deal.amount = numeric2(r.amount) ?? deal.amount
        deal.currency = r.currency ?? deal.currency
        deal.name = r.name ?? deal.name
        deal.appeared_in_import = true
        deal.updated_at = ctx.now()
        if (moves) {
          deal.outcome_seq += 1
          changed.push({ id: deal.id, seq: deal.outcome_seq })
        }
      }
    }
    report.push({
      organization_id: organization,
      import_id: id,
      row_number: r.row_number,
      deal_id: dealId,
      result: bad === null ? 'applied' : 'rejected',
      reason: bad,
    })
  }
  ctx.importRows.push(...report)
  const applied = report.filter((r) => r.result === 'applied').length
  imp.applied_count += applied
  imp.rejected_count += report.length - applied
  imp.report_through += taken.length
  imp.updated_at = ctx.now()
  return ctx.rows([
    summary(taken.length, applied, report.length - applied, null),
    ...changed.map((c) => ({
      kind: 'outcome_changed',
      deal_record_id: c.id,
      outcome_seq: c.seq,
      taken: null,
      applied: null,
      rejected: null,
      through: null,
      refusal: null,
    })),
  ])
}
