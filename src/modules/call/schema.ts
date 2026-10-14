import {
  type Call,
  type CallCursor,
  callCursorSchema,
  callFailureReasonSchema,
  callKindSchema,
  callMediaTypeSchema,
  callSchema,
  callStateSchema,
  dealIdSchema,
  dealRecordIdSchema,
  outcomeSchema,
  speakerLabelSchema,
  userIdSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import { cursorPosition, optionalTimestamp } from '~/modules/deal/schema'

/** The columns of a Call statement that the public Call is made from, checked as they leave the database. */
const callRowSchema = z.object({
  id: z.string(),
  deal_record_id: dealRecordIdSchema,
  deal_id: dealIdSchema,
  deal_outcome: outcomeSchema,
  in_search: z.boolean(),
  kind: callKindSchema,
  file_name: z.string(),
  media_type: callMediaTypeSchema,
  size_bytes: z.coerce.number().int(),
  duration_seconds: z.coerce.number().int().nullable(),
  state: callStateSchema,
  failure_reason: callFailureReasonSchema.nullable(),
  rep_by: z.enum(['speaker', 'channel']).nullable(),
  rep_label: speakerLabelSchema.nullable(),
  rep_channel: z.enum(['left', 'right']).nullable(),
  speaker_labels: z.array(speakerLabelSchema),
  deleted_at: z.union([z.string(), z.date()]).nullable(),
  purge_due_at: z.union([z.string(), z.date()]).nullable(),
  uploaded_by: userIdSchema,
  created_at: z.union([z.string(), z.date()]),
  updated_at: z.union([z.string(), z.date()]),
})

/**
 * Turns a Call statement row into the contract's Call; the service sends this output, never the
 * row. It carries no Transcript, turn or key of any object.
 */
export function toCall(row: Record<string, unknown>): Call {
  const r = callRowSchema.parse(row)
  const stamp = (value: string | Date) => optionalTimestamp.parse(value) as string
  const optional = (value: string | Date | null) => (value === null ? null : stamp(value))
  let rep: unknown = null
  if (r.rep_by === 'speaker') {
    rep = { by: 'speaker', label: r.rep_label }
  } else if (r.rep_by === 'channel') {
    rep = { by: 'channel', channel: r.rep_channel }
  }
  return callSchema.parse({
    id: r.id,
    dealId: r.deal_id,
    dealRecordId: r.deal_record_id,
    dealOutcome: r.deal_outcome,
    inSearch: r.in_search,
    kind: r.kind,
    fileName: r.file_name,
    mediaType: r.media_type,
    sizeBytes: r.size_bytes,
    durationSeconds: r.duration_seconds,
    state: r.state,
    failureReason: r.failure_reason,
    rep,
    speakerLabels: r.speaker_labels,
    deletedAt: optional(r.deleted_at),
    purgeAt: optional(r.purge_due_at),
    uploadedByUserId: r.uploaded_by,
    createdAt: stamp(r.created_at),
    updatedAt: stamp(r.updated_at),
  })
}

/** The Call-list cursor for the page after a row whose statement gave `cursor_at` text. */
export function callCursorOf(row: Record<string, unknown>): CallCursor {
  return callCursorSchema.parse(cursorPosition(row))
}
