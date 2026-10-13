import { createHash, timingSafeEqual } from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import { ERRORS } from 'tula-closeline-contract'
import { domainError } from '~/http/domain-error'
import type { AppEnv } from '~/http/types'

/** `Authorization: Bearer <secret>`, with the scheme in any case and exactly one token after it. */
const BEARER = /^Bearer ([^\s]+)$/i

/** Hashing first makes every comparison the same length, so a secret's length is not leaked. */
function digest(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}

/**
 * Whether `presented` equals any of `secrets`, in constant time per secret. Every configured
 * secret is compared even after one matches, so how long the answer takes says nothing about
 * which one it was or whether any was close.
 */
export function matchesAny(presented: string, secrets: readonly string[]): boolean {
  const presentedDigest = digest(presented)
  let matched = false
  for (const secret of secrets) {
    if (timingSafeEqual(presentedDigest, digest(secret))) {
      matched = true
    }
  }
  return matched
}

/**
 * Admits only a caller that presents one of the configured internal secrets as a bearer token:
 * the auth service. A missing or wrong secret is the contract's `auth.unauthenticated`, whichever
 * way it is wrong, and the secret is never logged. With no secret configured nothing gets in.
 *
 * This is a stand-in until services call each other with signed service tokens: replace this one
 * middleware and nothing else about the internal routes changes.
 */
export function internalAuth(secrets: readonly string[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const presented = BEARER.exec(c.req.header('authorization') ?? '')?.[1]
    if (presented === undefined || !matchesAny(presented, secrets)) {
      throw domainError(ERRORS['auth.unauthenticated'])
    }
    await next()
  })
}
