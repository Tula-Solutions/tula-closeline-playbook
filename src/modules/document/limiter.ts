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
