import {
  type Deal,
  type DealCursor,
  dealCursorSchema,
  dealIdSchema,
  dealRecordIdSchema,
  dealSchema,
  outcomeSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import { parsePgTimestamp } from '~/modules/document/schema'

/** A timestamp column (text or Date) as an ISO string, or null. */
export const optionalTimestamp = z
  .union([z.string(), z.date(), z.null()])
  .transform((value, context) => {
    if (value === null) {
      return null
    }
    const date = value instanceof Date ? value : parsePgTimestamp(value)
    if (date === undefined || Number.isNaN(date.getTime())) {
      context.addIssue({ code: 'custom', message: 'not a timestamp' })
      return z.NEVER
    }
    return date.toISOString()
  })

/** The columns of a Deal statement that the public Deal is made from, checked as they leave the database. */
const dealRowSchema = z.object({
  id: dealRecordIdSchema,
  deal_id: dealIdSchema,
  name: z.string().nullable(),
  outcome: outcomeSchema,
  closed_at: z.string().nullable(),
  amount: z.string().nullable(),
  currency: z.string().nullable(),
  appeared_in_import: z.boolean(),
  call_count: z.coerce.number().int().min(0),
  created_at: z.union([z.string(), z.date()]),
  updated_at: z.union([z.string(), z.date()]),
})

/** A Deal row's `outcome_seq`, which the message carries and the public Deal does not. */
export const outcomeSeqSchema = z.coerce.number().int().min(0)

/**
 * Turns a Deal statement row into the contract's Deal; the service sends this output, never the
 * row. `callCount` is the statement's `call_count`: the Deal's Calls that are not deleted.
 */
export function toDeal(row: Record<string, unknown>): Deal {
  const r = dealRowSchema.parse(row)
  const stamp = (value: string | Date) => optionalTimestamp.parse(value) as string
  return dealSchema.parse({
    id: r.id,
    dealId: r.deal_id,
    name: r.name,
    outcome: r.outcome,
    closedAt: r.closed_at,
    amount: r.amount,
    currency: r.currency,
    callCount: r.call_count,
    appearedInImport: r.appeared_in_import,
    createdAt: stamp(r.created_at),
    updatedAt: stamp(r.updated_at),
  })
}

/** `created_at::text` as Postgres prints it (`2026-10-13 12:34:56.123456+00`), the only form a cursor is built from. */
const CURSOR_TEXT =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)([+-]\d{2})(?::?(\d{2}))?$/

/** The cursor for the page after a row whose statement gave `cursor_at` text; the microseconds are kept as text, never through a Date. */
export function cursorPosition(row: Record<string, unknown>): { createdAt: string; id: string } {
  const text = z.string().parse(row.cursor_at)
  const match = CURSOR_TEXT.exec(text)
  if (match === null) {
    throw new Error('a list row has no usable cursor_at')
  }
  const [, day, time, hours, minutes = '00'] = match
  return { createdAt: `${day}T${time}${hours}:${minutes}`, id: z.string().parse(row.id) }
}

/** The Deal cursor for the page after `row`. */
export function cursorOf(row: Record<string, unknown>): DealCursor {
  return dealCursorSchema.parse(cursorPosition(row))
}

export { dealCursorSchema }
