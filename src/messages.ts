import {
  DEAL_OUTCOME_CHANGED_MESSAGE,
  DOCUMENT_DELETED_MESSAGE,
  DOCUMENT_UPLOADED_MESSAGE,
} from 'tula-closeline-contract'
import { createMessageRegistry, defineMessage, type EnvelopeOf } from 'tula-closeline-kit'

/** The message that starts ingestion of a document; its shape is the contract's. */
export const documentUploaded = defineMessage(DOCUMENT_UPLOADED_MESSAGE)

/** The message that queues the removal of a deleted document's vectors; its shape is the contract's. */
export const documentDeleted = defineMessage(DOCUMENT_DELETED_MESSAGE)

/**
 * The message that says a Deal's Outcome moved (ADR 0018), carrying only the Deal's record id and
 * its `outcomeSeq`. The Call re-tag job of a later ticket consumes it; until then it is
 * acknowledged and does nothing.
 */
export const dealOutcomeChanged = defineMessage(DEAL_OUTCOME_CHANGED_MESSAGE)

/** Every message type this service's queue carries. */
export type PlaybookDefinition =
  | typeof documentUploaded
  | typeof documentDeleted
  | typeof dealOutcomeChanged

/** An envelope of any type this service's queue carries. */
export type PlaybookEnvelope = EnvelopeOf<PlaybookDefinition>

/** Validates and builds the envelopes of {@link PlaybookDefinition}; shared by the queue and publishers. */
export const registry = createMessageRegistry([
  documentUploaded,
  documentDeleted,
  dealOutcomeChanged,
])
