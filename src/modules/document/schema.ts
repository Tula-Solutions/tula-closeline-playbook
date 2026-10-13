import {
  DOCUMENT_FAILURE_REASONS,
  documentIdSchema,
  documentSchema,
  documentStateSchema,
  MEDIA_TYPE_BY_EXTENSION,
  type PlaybookDocument,
  userIdSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'

/** A Postgres `timestamptz` as text, `2026-10-13 12:34:56.123456+00`, which is how the driver returns it. */
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/

/** Parses the text of a `timestamptz` into a Date, or `undefined` when it is not one. */
function parsePgTimestamp(text: string): Date | undefined {
  if (!PG_TIMESTAMP.test(text)) {
    return undefined
  }
  const iso = text.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** A timestamp column as the driver returns it (text, or a Date), turned into an ISO string. */
const timestampColumn = z.union([z.string(), z.date()]).transform((value, context) => {
  const date = value instanceof Date ? value : parsePgTimestamp(value)
  if (date === undefined || Number.isNaN(date.getTime())) {
    context.addIssue({ code: 'custom', message: 'not a timestamp' })
    return z.NEVER
  }
  return date.toISOString()
})

/** The columns of `DOCUMENT_GET` and of every list row (`DOCUMENT_ROW_FIELDS`) that the public document is made from, checked as they leave the database. */
const documentRowSchema = z.object({
  id: documentIdSchema,
  name: z.string(),
  state: documentStateSchema,
  size_bytes: z.coerce.number().int(),
  detected_type: z.enum(['pdf', 'docx', 'pptx', 'txt', 'md']),
  uploaded_by: userIdSchema,
  failure_reason: z.enum(DOCUMENT_FAILURE_REASONS).nullable(),
  deleted_at: timestampColumn.nullable(),
  purge_due_at: timestampColumn.nullable(),
  page_count: z.number().int().min(0).nullable(),
  created_at: timestampColumn,
  updated_at: timestampColumn,
})

/**
 * Turns a `DOCUMENT_GET` or list row into the contract's document. The contract says to send the
 * output of `documentSchema.parse`, never the row. `pageCount` is the row's `page_count`, null
 * until the ingestion job records it.
 */
export function toDocument(row: Record<string, unknown>): PlaybookDocument {
  const r = documentRowSchema.parse(row)
  return documentSchema.parse({
    id: r.id,
    fileName: r.name,
    mediaType: MEDIA_TYPE_BY_EXTENSION[`.${r.detected_type}`],
    sizeBytes: r.size_bytes,
    pageCount: r.page_count,
    state: r.state,
    failureReason: r.failure_reason,
    deletedAt: r.deleted_at,
    purgeAt: r.purge_due_at,
    uploadedByUserId: r.uploaded_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })
}

/** What a list cursor carries: the position after the last row of the page, in the database's own text. */
export const listCursorSchema = z.strictObject({
  /** `created_at::text` of the last row, which keeps the microseconds a JavaScript Date drops. */
  t: z
    .string()
    .max(40)
    .refine((text) => parsePgTimestamp(text) !== undefined),
  i: documentIdSchema,
})

/** What a list cursor carries. */
export type ListCursor = z.infer<typeof listCursorSchema>

/** The part of a list row the cursor is made from; the rest of the row is read by {@link toDocument}. */
export const listRowSchema = z.object({
  id: documentIdSchema,
  state: documentStateSchema,
  created_at: z.string().refine((text) => parsePgTimestamp(text) !== undefined),
})

/** The row of a list statement. */
export type ListRow = z.infer<typeof listRowSchema>
