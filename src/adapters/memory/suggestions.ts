import {
  DOCUMENT_LIST_MAX_PAGE,
  SUGGESTION_DECIDE,
  SUGGESTION_GET,
  SUGGESTION_INSERT,
  SUGGESTION_LIST,
  SUGGESTION_LIST_ACCEPTED,
  SUGGESTION_LIST_BY_STATUS,
} from 'tula-closeline-db'
import type { Result } from '~/adapters/postgres/processed-store'
import { LEARNING_GET, LEARNING_SET } from '~/modules/suggestion/statements'

/** One row of `playbook.suggestions`. Times are milliseconds except `created_at_us`. */
export type MemorySuggestionRow = {
  organization_id: string
  id: string
  kind: string
  status: 'pending' | 'accepted' | 'rejected'
  text: string
  /** The SHA-256 fingerprint as lower-case hex: unique per Organization. */
  fingerprint: string
  deal_record_id: string
  moments: unknown
  created_at_us: number
  decided_at: number | null
  decided_by_membership_id: string | null
}

/** What the Suggestion statements need from the double they run in. */
export type SuggestionStatementContext = {
  suggestions: MemorySuggestionRow[]
  settings: { organization_id: string; learn_from_agent_moments?: boolean }[]
  /** Creates the settings row a switch write needs, as the statement's insert would. */
  createSettings(organization: string, model: string, dimension: number): void
  own(organization: unknown): boolean
  now(): number
  nextMicroseconds(): number
  rows(list: readonly unknown[]): Result
  none: Result
  batch(value: unknown, max: number): number
  pgTimestamp(ms: number): string
  pgTimestampUs(us: number): string
  cursorMicroseconds(text: unknown): number
}

/** The hex of a bytea parameter (a `Uint8Array`, a `Buffer` or already hex text). */
function hexOf(value: unknown): string {
  if (value instanceof Uint8Array) {
    return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  return String(value)
}

/**
 * Runs one Suggestion statement of the db library (v0.50.0) or one of the learning switch's two
 * statements against the double, or returns `undefined` for any other statement. Only a transaction
 * scoped to the statement's Organization sees its rows.
 */
export function runSuggestionStatement(
  text: string,
  params: readonly unknown[],
  ctx: SuggestionStatementContext
): Result | undefined {
  const { rows, none, own } = ctx
  const mine = (organization: unknown) =>
    ctx.suggestions.filter((s) => own(organization) && s.organization_id === organization)
  const view = (s: MemorySuggestionRow) => ({
    id: s.id,
    kind: s.kind,
    status: s.status,
    text: s.text,
    deal_record_id: s.deal_record_id,
    moments: structuredClone(s.moments),
    created_at: ctx.pgTimestampUs(s.created_at_us),
    decided_at: s.decided_at === null ? null : ctx.pgTimestamp(s.decided_at),
    decided_by_membership_id: s.decided_by_membership_id,
  })
  const page = (organization: unknown, params: readonly unknown[], status?: string) => {
    const [, createdAfter, idAfter, size] = params as [unknown, string, string, unknown]
    const after = ctx.cursorMicroseconds(createdAfter)
    return rows(
      mine(organization)
        .filter((s) => status === undefined || s.status === status)
        .filter(
          (s) =>
            after === Number.POSITIVE_INFINITY ||
            s.created_at_us < after ||
            (s.created_at_us === after && s.id < String(idAfter))
        )
        .sort((a, b) =>
          a.created_at_us === b.created_at_us
            ? a.id < b.id
              ? 1
              : -1
            : b.created_at_us - a.created_at_us
        )
        .slice(0, ctx.batch(size, DOCUMENT_LIST_MAX_PAGE))
        .map((s) => ({ ...view(s), cursor_at: ctx.pgTimestampUs(s.created_at_us) }))
    )
  }
  switch (text) {
    case SUGGESTION_INSERT: {
      const [organization, id, kind, body, fingerprint, deal, moments] = params as [
        string,
        string,
        string,
        string,
        unknown,
        string,
        string,
      ]
      if (!own(organization)) {
        return none
      }
      const hex = hexOf(fingerprint)
      if (mine(organization).some((s) => s.fingerprint === hex)) {
        return none
      }
      const row: MemorySuggestionRow = {
        organization_id: organization,
        id,
        kind,
        status: 'pending',
        text: body,
        fingerprint: hex,
        deal_record_id: deal,
        moments: JSON.parse(moments),
        created_at_us: ctx.nextMicroseconds(),
        decided_at: null,
        decided_by_membership_id: null,
      }
      ctx.suggestions.push(row)
      return rows([view(row)])
    }
    case SUGGESTION_GET: {
      const [organization, id] = params as [string, string]
      return rows(
        mine(organization)
          .filter((s) => s.id === id)
          .map(view)
      )
    }
    case SUGGESTION_LIST:
      return page(params[0], params)
    case SUGGESTION_LIST_BY_STATUS:
      return page(params[0], params, String(params[4]))
    case SUGGESTION_LIST_ACCEPTED:
      return page(params[0], params, 'accepted')
    case SUGGESTION_DECIDE: {
      const [organization, id, status, member, replacement] = params as [
        string,
        string,
        'accepted' | 'rejected',
        string,
        string | null | undefined,
      ]
      const row = mine(organization).find((s) => s.id === id && s.status === 'pending')
      if (row === undefined) {
        return none
      }
      row.status = status
      row.decided_by_membership_id = member
      row.decided_at = ctx.now()
      row.text = replacement ?? row.text
      return rows([view(row)])
    }
    case LEARNING_GET: {
      const [organization] = params as [string]
      const row = ctx.settings.find((x) => own(organization) && x.organization_id === organization)
      return row === undefined
        ? none
        : rows([{ learn_from_agent_moments: row.learn_from_agent_moments ?? true }])
    }
    case LEARNING_SET: {
      const [organization, model, dimension, on] = params as [string, string, number, boolean]
      if (!own(organization)) {
        return none
      }
      if (!ctx.settings.some((x) => x.organization_id === organization)) {
        ctx.createSettings(organization, model, Number(dimension))
      }
      const row = ctx.settings.find((x) => x.organization_id === organization)
      if (row === undefined) {
        return none
      }
      row.learn_from_agent_moments = on
      return rows([{ learn_from_agent_moments: on }])
    }
    default:
      return undefined
  }
}
