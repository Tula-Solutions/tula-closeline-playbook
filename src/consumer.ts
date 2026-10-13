import type { ErrorReporter, Logger, ProcessedStore, Queue, Sleep } from 'tula-closeline-kit'
import { type Consumer, createConsumer, type Handlers } from 'tula-closeline-kit/queue'
import type { PlaybookEnvelope } from '~/messages'
import { ingestionHandlers, type Nudge } from '~/modules/ingestion/handlers'
import type { PipelineDeps } from '~/modules/ingestion/runtime'

/** The consumer's name: part of every idempotency key in `playbook.consumed_message`. */
export const CONSUMER_NAME = 'playbook.ingestion'

/**
 * The handler of each message type: the uploaded nudge and the deleted cleanup (hub issue 14).
 * A message type with no handler is hidden and ends in the dead-letter queue, so nothing may
 * publish a type before its handler is registered here.
 */
export function createHandlers(deps: PipelineDeps, nudge: Nudge): Handlers<PlaybookEnvelope> {
  return ingestionHandlers(deps, nudge)
}

/** What {@link createPlaybookConsumer} wires together. */
export type PlaybookConsumerOptions = {
  queue: Queue<PlaybookEnvelope>
  store: ProcessedStore
  logger: Logger
  errorReporter: ErrorReporter
  handlers: Handlers<PlaybookEnvelope>
  /** Messages handled at once. */
  concurrency: number
  /** Waits for timers; tests pass virtual time. */
  sleep?: Sleep
}

/** The queue consumer of this service: idempotent through the processed store, stopped by `stop`. */
export function createPlaybookConsumer(options: PlaybookConsumerOptions): Consumer {
  return createConsumer({
    name: CONSUMER_NAME,
    queue: options.queue,
    store: options.store,
    logger: options.logger,
    errorReporter: options.errorReporter,
    handlers: options.handlers,
    concurrency: options.concurrency,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  })
}
