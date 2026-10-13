import type { MiddlewareHandler } from 'hono'
import { ERRORS } from 'tula-closeline-contract'
import { respond } from '~/http/errors'
import type { AppEnv } from '~/http/types'

/**
 * A middleware that refuses a request whose declared `content-length` is over `maxSize`, and
 * reads nothing: unlike Hono's `bodyLimit`, it never buffers a body that has no length, so a
 * route with a large limit cannot be made to hold that much before it has authenticated the
 * caller. The route reads its body through {@link capBody}, which cuts a body off at the limit.
 */
export function declaredLengthLimit(maxSize: number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const declared = c.req.header('content-length')
    if (declared !== undefined && /^\d{1,15}$/.test(declared) && Number(declared) > maxSize) {
      return respond(c, ERRORS['request.too_large'])
    }
    return next()
  }
}

/** A request whose body is cut off once over its limit or its deadline, and which of the two it was. */
export type CappedRequest = {
  request: Request
  exceeded: () => boolean
  /** Whether the body was cut off because `signal` aborted before it was complete. */
  timedOut: () => boolean
}

/**
 * The same request with a body that errors as soon as more than `maxBytes` have been read from
 * it, so a body with no declared length (or a lying one) is never read past the limit. When
 * `signal` aborts first, the body errors too and the source is cancelled, so a sender that stalls
 * cannot hold the reader past the deadline.
 */
export function capBody(request: Request, maxBytes: number, signal?: AbortSignal): CappedRequest {
  let size = 0
  let over = false
  let late = false
  if (request.body === null) {
    return { request, exceeded: () => false, timedOut: () => false }
  }
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      const abort = () => {
        late = true
        controller.error(new Error('The request body did not arrive in time'))
      }
      if (signal?.aborted) {
        abort()
      } else {
        signal?.addEventListener('abort', abort, { once: true })
      }
    },
    transform(chunk, controller) {
      size += chunk.byteLength
      if (size > maxBytes) {
        over = true
        controller.error(new Error('The request body is over its limit'))
        return
      }
      controller.enqueue(chunk)
    },
  })
  const capped = new Request(request, { body: request.body.pipeThrough(counter), duplex: 'half' })
  return { request: capped, exceeded: () => over, timedOut: () => late }
}
