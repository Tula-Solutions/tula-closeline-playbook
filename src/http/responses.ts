import { errorBodySchema } from 'tula-closeline-contract'

/** Describes a failure response in a route's OpenAPI definition with the contract's error body. */
export function errorResponse(description: string) {
  return {
    description,
    content: { 'application/json': { schema: errorBodySchema } },
  }
}
