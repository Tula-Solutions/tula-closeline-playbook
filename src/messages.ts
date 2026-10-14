import {
  CALL_DELETED_MESSAGE,
  CALL_REP_CHANGED_MESSAGE,
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
 * its `outcomeSeq`. It only nudges the re-tag job; discovery (`outcome_retag`) is what finds the
 * work, so a lost message loses nothing.
 */
export const dealOutcomeChanged = defineMessage(DEAL_OUTCOME_CHANGED_MESSAGE)

/** The message that queues the removal of a deleted Call's vectors; its shape is the contract's. */
export const callDeleted = defineMessage(CALL_DELETED_MESSAGE)

/** The message that says a Call's Rep changed (the rebuild is found by `call_jobs`; this only nudges). */
export const callRepChanged = defineMessage(CALL_REP_CHANGED_MESSAGE)

/** Every message type this service's queue carries. */
export type PlaybookDefinition =
  | typeof documentUploaded
  | typeof documentDeleted
  | typeof dealOutcomeChanged
  | typeof callDeleted
  | typeof callRepChanged

/** An envelope of any type this service's queue carries. */
export type PlaybookEnvelope = EnvelopeOf<PlaybookDefinition>

/** Validates and builds the envelopes of {@link PlaybookDefinition}; shared by the queue and publishers. */
export const registry = createMessageRegistry([
  documentUploaded,
  documentDeleted,
  dealOutcomeChanged,
  callDeleted,
  callRepChanged,
])
