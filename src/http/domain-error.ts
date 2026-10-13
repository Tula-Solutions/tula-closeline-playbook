import type { ErrorDefinition } from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'

/** Builds the AppError for a registry error, so the one error handler answers with its status. */
export function domainError(definition: ErrorDefinition): AppError {
  return new AppError({
    code: definition.code,
    status: definition.status,
    message: definition.message,
  })
}

/**
 * An answer that also tells the client when to try again (`Retry-After`, in seconds): a
 * `rate.limited`, or a `request.idempotency_in_progress` that also carries `details.retryAfter`.
 */
export class RetryAfterError extends AppError {
  readonly retryAfterSeconds: number

  constructor(
    definition: ErrorDefinition,
    retryAfterSeconds: number,
    details?: Record<string, unknown>
  ) {
    super({
      code: definition.code,
      status: definition.status,
      message: definition.message,
      ...(details === undefined ? {} : { details }),
    })
    this.name = 'RetryAfterError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}
