import { createMiddleware } from 'hono/factory'
import { formatId, type RequestId, requestIdSchema } from 'tula-closeline-contract'
import type { Container } from '~/container'
import type { AppEnv } from '~/http/types'

/** The header that carries the request id in both directions. */
export const REQUEST_ID_HEADER = 'x-request-id'

/** Returns the caller's request id when it is well-formed, otherwise a newly minted one. */
export function resolveRequestId(inbound: string | undefined): RequestId {
  const parsed = requestIdSchema.safeParse(inbound)
  return parsed.success ? parsed.data : formatId('req', crypto.randomUUID())
}

/** Gives every request an id, echoes it on the response and binds it to a child logger. */
export function requestId(container: Container) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const id = resolveRequestId(c.req.header(REQUEST_ID_HEADER))
    c.set('requestId', id)
    c.set('logger', container.logger.child({ requestId: id }))

    await next()

    // After the handler, on whatever response it or the error handler produced. The guard sets the
    // id itself on the one response it builds without a context.
    c.res.headers.set(REQUEST_ID_HEADER, id)
  })
}
