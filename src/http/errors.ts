import type { Context, ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ERRORS, type ErrorDefinition, type RequestId } from 'tula-closeline-contract'
import { isAppError, toErrorBody } from 'tula-closeline-kit'
import { type Container, reportSafely } from '~/container'
import { REQUEST_ID_HEADER } from '~/http/request-id'
import type { AppEnv } from '~/http/types'

/** Errors with this status or above are the service's fault and go to `reportError`. */
const SERVER_ERROR = 500

/** The lowest HTTP status that is an error at all. */
const CLIENT_ERROR = 400

/** The highest HTTP status. */
const MAX_STATUS = 599

/**
 * The registry error each HTTP status maps to. A status missing here is a client error that keeps
 * its status under `request.invalid` (4xx), or a generic `server.internal` (5xx). Spelled out so
 * that no status silently takes another's meaning.
 */
const BY_STATUS: Readonly<Record<number, ErrorDefinition>> = {
  400: ERRORS['request.invalid'],
  401: ERRORS['auth.unauthenticated'],
  403: ERRORS['auth.forbidden'],
  404: ERRORS['request.not_found'],
  405: ERRORS['request.method_not_allowed'],
  409: ERRORS['request.conflict'],
  413: ERRORS['request.too_large'],
  415: ERRORS['request.unsupported_media_type'],
  422: ERRORS['request.unprocessable'],
  429: ERRORS['rate.limited'],
  500: ERRORS['server.internal'],
  503: ERRORS['server.unavailable'],
  504: ERRORS['server.timeout'],
}

/** Builds the response for a registry error, with an optional status override. */
export function respond(c: Context<AppEnv>, definition: ErrorDefinition, status?: number) {
  const body = { error: { code: definition.code, message: definition.message } }
  return c.json(body, (status ?? definition.status) as ContentfulStatusCode)
}

/** The generic 500 as a bare Response, for places with no Hono context to build one from. */
export function internalErrorResponse(requestId: RequestId): Response {
  const { code, message } = ERRORS['server.internal']
  return new Response(JSON.stringify({ error: { code, message } }), {
    status: SERVER_ERROR,
    headers: { 'content-type': 'application/json', [REQUEST_ID_HEADER]: requestId },
  })
}

/** Whether `status` is one a client can be sent as an error. */
function isErrorStatus(status: number): boolean {
  return Number.isInteger(status) && status >= CLIENT_ERROR && status <= MAX_STATUS
}

/**
 * The one error handler. An AppError keeps its own code and status; an HTTPException maps by
 * status; anything else, and any status that is not an error status, is a 500 with a generic body
 * that goes to `reportError`. Only server errors are reported.
 */
export function createErrorHandler(container: Container): ErrorHandler<AppEnv> {
  const report = (error: unknown, c: Context<AppEnv>, status: number): void =>
    reportSafely(container, error, {
      requestId: c.get('requestId'),
      organizationId: c.get('organizationId'),
      method: c.req.method,
      path: c.req.path,
      status,
    })

  const internal = (error: unknown, c: Context<AppEnv>) => {
    report(error, c, SERVER_ERROR)
    return respond(c, ERRORS['server.internal'])
  }

  return (error, c) => {
    if (isAppError(error)) {
      if (!isErrorStatus(error.status)) {
        return internal(error, c)
      }
      if (error.status >= SERVER_ERROR) {
        report(error, c, error.status)
      }
      return c.json(toErrorBody(error), error.status as ContentfulStatusCode)
    }

    if (error instanceof HTTPException) {
      if (!isErrorStatus(error.status)) {
        return internal(error, c)
      }
      const mapped = BY_STATUS[error.status]
      if (error.status < SERVER_ERROR) {
        return mapped ? respond(c, mapped) : respond(c, ERRORS['request.invalid'], error.status)
      }
      const definition = mapped ?? ERRORS['server.internal']
      report(error, c, definition.status)
      return respond(c, definition)
    }

    return internal(error, c)
  }
}

/** The handler for a path no route matches: a 404 in the contract's error body. */
export const notFoundHandler: NotFoundHandler<AppEnv> = (c) =>
  respond(c, ERRORS['request.not_found'])
