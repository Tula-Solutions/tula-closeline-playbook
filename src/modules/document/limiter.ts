/** A counter that lets at most `max` holders in at once and never makes anyone wait. */
export type ConcurrencyGate = {
  /** Takes a place and returns the function that gives it back, or `undefined` when all are taken. */
  tryAcquire(): (() => void) | undefined
  /** How many places are taken now. */
  readonly active: number
}

/**
 * Bounds how many uploads one instance holds in memory at once (ADR 0016: the whole file is held).
 * It is a resource bound for this process, not shared state: another instance has its own, so the
 * Organization-wide rules live in Postgres, not here.
 */
export function createConcurrencyGate(max: number): ConcurrencyGate {
  let active = 0
  return {
    tryAcquire() {
      if (active >= max) {
        return undefined
      }
      active += 1
      let released = false
      return () => {
        if (!released) {
          released = true
          active -= 1
        }
      }
    },
    get active() {
      return active
    },
  }
}

/** A per-Organization cap on the places of a {@link ConcurrencyGate}, so one Organization cannot fill it. */
export type OrganizationShare = {
  /** Takes a place for `organizationId` and returns the function that gives it back, or `undefined` at its share. */
  tryAcquire(organizationId: string): (() => void) | undefined
  /** How many Organizations hold a place now. */
  readonly organizations: number
}

/**
 * Caps the places one Organization may hold at half of `places`, rounded up, and at least one.
 * Like the gate it is request-scoped state of this process, not shared: it bounds a slow or abusive
 * sender, and holds an entry only while that Organization has an upload running.
 */
export function createOrganizationShare(places: number): OrganizationShare {
  const share = Math.max(1, Math.ceil(places / 2))
  const held = new Map<string, number>()
  return {
    tryAcquire(organizationId) {
      const count = held.get(organizationId) ?? 0
      if (count >= share) {
        return undefined
      }
      held.set(organizationId, count + 1)
      let released = false
      return () => {
        if (released) {
          return
        }
        released = true
        const left = (held.get(organizationId) ?? 1) - 1
        if (left <= 0) {
          held.delete(organizationId)
        } else {
          held.set(organizationId, left)
        }
      }
    },
    get organizations() {
      return held.size
    },
  }
}
