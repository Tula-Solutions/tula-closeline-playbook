import {
  type DealImport,
  type DealImportRow,
  dealImportCursorSchema,
  dealImportFailureReasonSchema,
  dealImportIdSchema,
  dealImportRowReasonSchema,
  dealImportRowResultSchema,
  dealImportRowSchema,
  dealImportSchema,
  dealImportStateSchema,
  userIdSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import { cursorPosition, optionalTimestamp } from '~/modules/deal/schema'

/** The columns of a Deal import statement that the public import is made from, checked as they leave the database. */
const importRowSchema = z.object({
  id: dealImportIdSchema,
  state: dealImportStateSchema,
  failure_reason: dealImportFailureReasonSchema.nullable(),
  row_count: z.coerce.number().int().min(0).nullable(),
  applied_count: z.coerce.number().int().min(0).nullable(),
  rejected_count: z.coerce.number().int().min(0).nullable(),
  uploaded_by: userIdSchema,
  created_at: z.union([z.string(), z.date()]),
  updated_at: z.union([z.string(), z.date()]),
})

/** Turns a Deal import statement row into the contract's import; the service sends this output, never the row. */
export function toDealImport(row: Record<string, unknown>): DealImport {
  const r = importRowSchema.parse(row)
  const stamp = (value: string | Date) => optionalTimestamp.parse(value) as string
  return dealImportSchema.parse({
    id: r.id,
    state: r.state,
    failureReason: r.failure_reason,
    rowCount: r.row_count,
    appliedCount: r.applied_count,
    rejectedCount: r.rejected_count,
    uploadedByUserId: r.uploaded_by,
    createdAt: stamp(r.created_at),
    updatedAt: stamp(r.updated_at),
  })
}

/** The import-list cursor for the page after a row whose statement gave `cursor_at` text. */
export function importCursorOf(
  row: Record<string, unknown>
): z.infer<typeof dealImportCursorSchema> {
  return dealImportCursorSchema.parse(cursorPosition(row))
}

/** The columns of a report row: the row number, the deal id and the result, and nothing else of the CSV. */
const reportRowSchema = z.object({
  row_number: z.coerce.number().int().min(2),
  deal_id: z.string().nullable(),
  result: dealImportRowResultSchema,
  reason: dealImportRowReasonSchema.nullable(),
})

/** Turns a report row into the contract's row; no other cell of the CSV exists in the table, so none can be returned. */
export function toImportRow(row: Record<string, unknown>): DealImportRow {
  const r = reportRowSchema.parse(row)
  return dealImportRowSchema.parse({
    rowNumber: r.row_number,
    dealId: r.deal_id,
    result: r.result,
    reason: r.reason,
  })
}
