import type { CallFailureReason } from 'tula-closeline-contract'

/** A Call that cannot be processed by trying again: it ends `failed` with this reason. */
export class CallFailure extends Error {
  constructor(readonly reason: CallFailureReason) {
    super(`the Call failed: ${reason}`)
    this.name = 'CallFailure'
  }
}
