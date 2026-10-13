import type { ErrorReporter, Logger, ProcessedStore, Queue, Sleep } from 'tula-closeline-kit'
import { type Consumer, createConsumer, type Handlers } from 'tula-closeline-kit/queue'
import type { PlaybookEnvelope } from '~/messages'

/** The consumer's name: part of every idempotency key in `playbook.consumed_message`. */
export const CONSUMER_NAME = 'playbook.ingestion'

/**
 * The handler of each message type. Empty on purpose until the ingestion pipeline (hub issue 14)
 * registers its steps here: a message with no handler is hidden and ends in the dead-letter queue,
 * so nothing may publish a message type before its handler exists.
 */
export function createHandlers(): Handlers<PlaybookEnvelope> {
  return {}
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
