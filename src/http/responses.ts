import {
  errorBodySchema,
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeySchema,
} from 'tula-closeline-contract'
import { z } from 'zod'

/** Describes a failure response in a route's OpenAPI definition with the contract's error body. */
export function errorResponse(description: string) {
  return {
    description,
    content: { 'application/json': { schema: errorBodySchema } },
  }
}

/** Describes a failure response that also carries `Retry-After` (whole seconds). */
export function errorResponseWithRetryAfter(description: string) {
  return {
    ...errorResponse(description),
    headers: z.object({
      'Retry-After': z
        .string()
        .regex(/^[1-9][0-9]*$/)
        .meta({ description: 'Whole seconds to wait before trying again.' }),
    }),
  }
}

/** The optional `Idempotency-Key` header of a call with effects, 16 to 128 characters from `A-Za-z0-9_.:-`. */
export function idempotencyKeyHeader(description: string) {
  return z.object({
    [IDEMPOTENCY_KEY_HEADER.toLowerCase()]: idempotencyKeySchema.optional().meta({ description }),
  })
}

/** The required `Idempotency-Key` header of an internal call with effects. */
export function requiredIdempotencyKeyHeader(description: string) {
  return z.object({
    'idempotency-key': idempotencyKeySchema.meta({ description }),
  })
}
