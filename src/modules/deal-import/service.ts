import {
  checkDealImportHeaderText,
  DEAL_IMPORT_HEADER_PREFIX_CHARS,
  type DealImport,
  dealImportCursorSchema,
  dealImportRowCursorSchema,
  dealImportSchema,
  decodeCursor,
  encodeCursor,
  formatId,
  type ListDealImportRowsQuery,
  type ListDealImportRowsResponse,
  type ListDealImportsQuery,
  type ListDealImportsResponse,
  MAX_DEAL_IMPORT_BYTES,
  normaliseMediaType,
  SALES_HISTORY_READ_ROLES,
} from 'tula-closeline-contract'
import {
  DEAL_IMPORT_GET,
  DEAL_IMPORT_INSERT,
  DEAL_IMPORT_LIST,
  DEAL_IMPORT_ROWS_LIST,
  DEAL_IMPORT_ROWS_LIST_BY_RESULT,
} from 'tula-closeline-db'
import { AppError } from 'tula-closeline-kit'
import type { Run } from '~/adapters/postgres/processed-store'
import type { Container } from '~/container'
import {
  completeKey,
  type KeyedRequest,
  LOCK_TIMEOUT_SQL,
  requestHashOf,
  reserveKey,
} from '~/modules/document/idempotency'
import {
  asStorageFailure,
  ObjectRequired,
  recordUploadAttempt,
  rolledBack,
  sha256,
} from '~/modules/document/service'
import {
  assertRole,
  type CallContext,
  failure,
  mappingBadCursor,
  transaction,
} from '~/modules/service-kit'
import { importObjectKey } from './keys'
import { importCursorOf, toDealImport, toImportRow } from './schema'

/** What the Deal import service needs from the container. */
export type DealImportDeps = Pick<Container, 'scope' | 'objects' | 'logger' | 'env'>

/** The route name an import upload's idempotency key is stored under. */
export const IMPORT_UPLOAD_IDEMPOTENCY_ROUTE = 'deal_imports.upload'

/** The media types a CSV may be declared as; an absent declaration is accepted, the name decides. */
const CSV_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'text/plain',
  'application/octet-stream',
])

/**
 * Refuses a file that is too large or not a CSV by its name and declared type, from what is known
 * before its bytes are copied out: `deal_import.too_large` (413) first, then
 * `deal_import.unsupported_type` (415). The header is judged later, on the bytes.
 */
export function assertImportable(file: {
  fileName: string
  declaredMediaType: string | null
  sizeBytes: number
}): void {
  if (file.sizeBytes > MAX_DEAL_IMPORT_BYTES) {
    throw failure('deal_import.too_large')
  }
  const declared =
    file.declaredMediaType === null ? null : normaliseMediaType(file.declaredMediaType)
  if (
    !/\.csv$/i.test(file.fileName.trim()) ||
    (declared !== null && declared !== '' && !CSV_MEDIA_TYPES.has(declared))
  ) {
    throw failure('deal_import.unsupported_type')
  }
}

/**
 * Judges the header from the first {@link DEAL_IMPORT_HEADER_PREFIX_CHARS} characters of the file,
 * with the contract's reader, before anything is stored. A refusal is `deal_import.header_invalid`
 * (422) with the closed `problem` and never a cell; a header still unfinished in the prefix is
 * left to the job.
 */
export function assertHeader(bytes: Uint8Array): void {
  // A character is at most four bytes; the prefix is cut to characters after decoding.
  const prefix = new TextDecoder('utf-8')
    .decode(bytes.subarray(0, DEAL_IMPORT_HEADER_PREFIX_CHARS * 4))
    .slice(0, DEAL_IMPORT_HEADER_PREFIX_CHARS)
  const checked = checkDealImportHeaderText(prefix)
  if (!checked.ok) {
    const refusal = failure(checked.code)
    throw new AppError({
      code: refusal.code,
      status: refusal.status,
      message: refusal.message,
      details: { problem: checked.problem },
    })
  }
}

/** What the upload transaction decided. */
type UploadOutcome =
  | { kind: 'replay'; status: number; response: unknown }
  | { kind: 'done'; dealImport: DealImport; inserted: boolean }

/** What an upload answers. */
export type ImportUploadResult = { status: 202; dealImport: DealImport }

/** What a caller hands the upload: the file's bytes (the limit is already enforced) and an optional key. */
export type ImportUploadInput = {
  fileName: string
  declaredMediaType: string | null
  bytes: Uint8Array
  idempotencyKey: string | undefined
}

/**
 * Stores one CSV and queues its import. Owner and Admin only. The order, and why:
 *
 * 1. Check size, type and the header on the bytes. Nothing is stored yet.
 * 2. One transaction: claim the idempotency key, then insert the import row (it takes no lock that
 *    another import waits for). When the insert is the next step and the file is not stored, the
 *    transaction rolls back with `ObjectRequired`.
 * 3. An upload-attempt record is committed, so the orphan sweep can find an object whose outcome is
 *    unknown, then the file is written under a key made from the new import id, then the
 *    transaction runs again.
 *
 * Crash points: before the object write nothing exists; after the write and before the commit the
 * file is an orphan no row names (removed at once when the failure is certain to have rolled back,
 * left to the orphan sweep when it is not); after the commit the import is `uploaded` and the job
 * loop finds it by its work hint, so there is nothing to publish.
 *
 * The file is held in memory once, up to the 10 MB limit (the object store port takes whole bodies).
 */
export async function upload(
  deps: DealImportDeps,
  context: CallContext,
  input: ImportUploadInput
): Promise<ImportUploadResult> {
  assertRole(context, SALES_HISTORY_READ_ROLES)
  assertImportable({
    fileName: input.fileName,
    declaredMediaType: input.declaredMediaType,
    sizeBytes: input.bytes.byteLength,
  })
  assertHeader(input.bytes)
  const organizationId = context.organizationId
  const contentHash = await sha256(input.bytes)
  const keyed: KeyedRequest = {
    key: input.idempotencyKey,
    organizationId,
    userId: context.userId,
    route: IMPORT_UPLOAD_IDEMPOTENCY_ROUTE,
    requestHash: requestHashOf(IMPORT_UPLOAD_IDEMPOTENCY_ROUTE, {
      contentHash: contentHash.toString('hex'),
    }),
  }
  const importId = formatId('dimp', crypto.randomUUID())
  const objectKey = importObjectKey(importId)
  let stored = false

  const decide = async (run: Run): Promise<UploadOutcome> => {
    await run(LOCK_TIMEOUT_SQL, [])
    // The key first, as every upload does: two calls with one key then queue on the key.
    const reservation = await reserveKey(run, keyed)
    if (reservation.kind === 'replay') {
      return reservation
    }
    if (!stored) {
      throw new ObjectRequired()
    }
    const inserted = await run(DEAL_IMPORT_INSERT, [
      organizationId,
      importId,
      context.userId,
      objectKey,
      input.bytes.byteLength,
    ])
    const row = inserted.rows[0]
    if (row === undefined) {
      throw new Error('A Deal import the upload just wrote could not be read back')
    }
    const dealImport = toDealImport(row)
    await completeKey(run, keyed, 202, dealImport)
    return { kind: 'done', dealImport, inserted: true }
  }

  for (let attempt = 0; ; attempt++) {
    let outcome: UploadOutcome
    try {
      outcome = await transaction(deps, organizationId, decide)
    } catch (error) {
      if (error instanceof ObjectRequired && attempt === 0) {
        await recordUploadAttempt(deps, context)
        try {
          await deps.objects.put(organizationId, objectKey, input.bytes, {
            contentType: 'text/csv',
          })
        } catch (putError) {
          deps.logger.warn(
            'an import upload failed with an unknown outcome; its file may be in place',
            {
              organizationId,
              importId,
            }
          )
          throw asStorageFailure(putError)
        }
        stored = true
        continue
      }
      if (stored) {
        await settleObject(deps, organizationId, objectKey, importId, rolledBack(error))
      }
      throw error
    }
    if (outcome.kind === 'replay') {
      if (stored) {
        // The same key committed first: this file was not needed.
        await settleObject(deps, organizationId, objectKey, importId, true)
      }
      const replayed = dealImportSchema.parse(outcome.response)
      return { status: 202, dealImport: replayed }
    }
    return { status: 202, dealImport: outcome.dealImport }
  }
}

/** Removes the object of an upload that left no row, when that is certain; otherwise leaves it and says so. */
async function settleObject(
  deps: Pick<DealImportDeps, 'objects' | 'logger'>,
  organizationId: string,
  objectKey: string,
  importId: string,
  certain: boolean
): Promise<void> {
  if (!certain) {
    deps.logger.warn('an import upload failed with an unknown outcome; its file is left in place', {
      organizationId,
      importId,
    })
    return
  }
  try {
    await deps.objects.delete(organizationId, objectKey)
  } catch (error) {
    deps.logger.warn('the file of an import that was not stored could not be removed', {
      organizationId,
      importId,
      error: error instanceof Error ? error.name : 'unknown',
    })
  }
}

/** Reads one import of the caller's Organization; another Organization's, or an erased one, is `deal_import.not_found`. */
export async function get(
  deps: DealImportDeps,
  context: CallContext,
  importId: string
): Promise<DealImport> {
  assertRole(context, SALES_HISTORY_READ_ROLES)
  const organizationId = context.organizationId
  const row = await transaction(
    deps,
    organizationId,
    async (run) => (await run(DEAL_IMPORT_GET, [organizationId, importId])).rows[0]
  )
  if (row === undefined) {
    throw failure('deal_import.not_found')
  }
  return toDealImport(row)
}

/** One page of the Organization's imports, newest first, by the statement's text cursor. */
export async function list(
  deps: DealImportDeps,
  context: CallContext,
  query: ListDealImportsQuery
): Promise<ListDealImportsResponse> {
  assertRole(context, SALES_HISTORY_READ_ROLES)
  const organizationId = context.organizationId
  const after = query.cursor === undefined ? undefined : readImportCursor(query.cursor)
  const rows = await mappingBadCursor(() =>
    transaction(
      deps,
      organizationId,
      async (run) =>
        (
          await run(DEAL_IMPORT_LIST, [
            organizationId,
            after?.createdAt ?? 'infinity',
            after?.id ?? '',
            query.limit,
          ])
        ).rows
    )
  )
  const last = rows.at(-1)
  return {
    items: rows.map((row) => toDealImport(row)),
    nextCursor:
      rows.length === query.limit && last !== undefined ? encodeCursor(importCursorOf(last)) : null,
  }
}

/** The position an import-list cursor names, or `request.invalid` for a cursor that is not one. */
function readImportCursor(cursor: string): { createdAt: string; id: string } {
  const decoded = decodeCursor(cursor, dealImportCursorSchema)
  if (decoded === undefined) {
    throw failure('request.invalid')
  }
  return decoded
}

/**
 * One page of an import's report in CSV order: the row number, the deal id when it was valid, the
 * result and the reason. The cursor is the row number of the last row returned; `result` limits
 * the page to applied or rejected rows. An import that does not exist is `deal_import.not_found`.
 */
export async function listRows(
  deps: DealImportDeps,
  context: CallContext,
  importId: string,
  query: ListDealImportRowsQuery
): Promise<ListDealImportRowsResponse> {
  assertRole(context, SALES_HISTORY_READ_ROLES)
  const organizationId = context.organizationId
  let after = 0
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(query.cursor, dealImportRowCursorSchema)
    if (decoded === undefined) {
      throw failure('request.invalid')
    }
    after = decoded.rowNumber
  }
  const found = await transaction(deps, organizationId, async (run) => {
    const parent = (await run(DEAL_IMPORT_GET, [organizationId, importId])).rows[0]
    if (parent === undefined) {
      return undefined
    }
    const statement =
      query.result === undefined ? DEAL_IMPORT_ROWS_LIST : DEAL_IMPORT_ROWS_LIST_BY_RESULT
    const params =
      query.result === undefined
        ? [organizationId, importId, after, query.limit]
        : [organizationId, importId, after, query.limit, query.result]
    return (await run(statement, params)).rows
  })
  if (found === undefined) {
    throw failure('deal_import.not_found')
  }
  const items = found.map((row) => toImportRow(row))
  const last = items.at(-1)
  return {
    items,
    nextCursor:
      found.length === query.limit && last !== undefined
        ? encodeCursor({ rowNumber: last.rowNumber })
        : null,
  }
}
