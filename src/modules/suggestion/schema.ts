import { createHash } from 'node:crypto'
import {
  callIdSchema,
  dealRecordIdSchema,
  MAX_SUGGESTION_MOMENTS,
  membershipIdSchema,
  type Suggestion,
  suggestionIdSchema,
  suggestionKindSchema,
  suggestionSchema,
  suggestionStatusSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import { optionalTimestamp } from '~/modules/deal/schema'

/** The path parameters of the Suggestion routes that name one Suggestion. */
export const suggestionParamsSchema = z.object({ suggestionId: suggestionIdSchema })

/** One cited Moment as the `moments` column stores it. */
const storedMomentSchema = z.object({
  kind: z.literal('moment'),
  callId: callIdSchema,
  dealRecordId: dealRecordIdSchema,
  momentIndex: z.number().int().min(0).optional(),
})

/** The columns of a Suggestion statement that the public Suggestion is made from. */
const suggestionRowSchema = z.object({
  id: suggestionIdSchema,
  kind: suggestionKindSchema,
  status: suggestionStatusSchema,
  text: z.string(),
  deal_record_id: dealRecordIdSchema,
  moments: z.array(storedMomentSchema).max(MAX_SUGGESTION_MOMENTS),
  created_at: z.union([z.string(), z.date()]),
  decided_at: z.union([z.string(), z.date(), z.null()]),
  decided_by_membership_id: membershipIdSchema.nullable(),
})

/** Turns a Suggestion statement row into the contract's Suggestion; the service sends this, never the row. */
export function toSuggestion(row: Record<string, unknown>): Suggestion {
  const r = suggestionRowSchema.parse({
    ...row,
    moments: typeof row.moments === 'string' ? JSON.parse(row.moments) : row.moments,
  })
  return suggestionSchema.parse({
    id: r.id,
    kind: r.kind,
    status: r.status,
    text: r.text,
    provenance: { dealRecordId: r.deal_record_id, moments: r.moments },
    createdAt: optionalTimestamp.parse(r.created_at),
    decidedAt: optionalTimestamp.parse(r.decided_at),
    decidedByMembershipId: r.decided_by_membership_id,
  })
}

/** The Moments a stored Suggestion cites, without the `kind` tag, for a search answer. */
export function momentRefsOf(row: Record<string, unknown>): {
  callId: string
  dealRecordId: string
  momentIndex?: number
}[] {
  return toSuggestion(row).provenance.moments.map((moment) => ({
    callId: moment.callId,
    dealRecordId: moment.dealRecordId,
    ...(moment.momentIndex === undefined ? {} : { momentIndex: moment.momentIndex }),
  }))
}

/** The text with runs of white space collapsed and lower-cased: what two Suggestions are compared by. */
export function normalisedText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** The 32-byte fingerprint of a kind and text: the same advice twice is one Suggestion, rejected or not. */
export function fingerprintOf(kind: string, text: string): Buffer {
  return createHash('sha256')
    .update(`${kind}\n${normalisedText(text)}`)
    .digest()
}

/**
 * The id of the Membership that decided, derived from the token's Organization and user because
 * the access token carries no Membership id: `mem_` and 32 hex digits of a SHA-256, stable per person.
 */
export function deciderMembershipId(organizationId: string, userId: string): string {
  const hex = createHash('sha256').update(`${organizationId}:${userId}`).digest('hex').slice(0, 32)
  return `mem_${hex}`
}

/** The vector id of an accepted Suggestion: `sug_` and the 32 hex digits of its id. */
export function suggestionVectorId(suggestionId: string): string {
  return `sug_${suggestionId.replace(/^sgs_/, '')}`
}

/** The cursor of a Suggestion list: the keyset position the statement printed. */
export const suggestionCursorSchema = z.object({ createdAt: z.string(), id: z.string() })
