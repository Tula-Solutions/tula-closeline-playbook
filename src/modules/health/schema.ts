import { z } from 'zod'

/** The body of `/healthz`: the process is up and which shared libraries it resolved. */
export const livenessSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  libraries: z.array(z.string()),
})

/** How one readiness check ended: it passed, it failed, or it ran out of time. */
export const checkStatusSchema = z.enum(['ok', 'failed', 'timeout'])

/** The result of one readiness check, by name; the reason is never returned to the caller. */
export const checkResultSchema = z.object({
  name: z.string(),
  status: checkStatusSchema,
})

/** The body of `/readyz`: ready only when every check passed. */
export const readinessSchema = z.object({
  status: z.enum(['ready', 'unavailable']),
  checks: z.array(checkResultSchema),
})

/** The body of `/healthz`. */
export type Liveness = z.infer<typeof livenessSchema>

/** The result of one readiness check. */
export type CheckResult = z.infer<typeof checkResultSchema>

/** The body of `/readyz`. */
export type Readiness = z.infer<typeof readinessSchema>
