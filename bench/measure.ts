/** Requests per timed batch. */
export const BATCH_REQUESTS = 500

/** Timed batches per benchmark; the gate uses the fastest, so up to six can stall unseen. */
export const BATCHES = 7

/** Requests run, untimed, before the first batch, so the JIT and module caches are warm. */
export const WARMUP_REQUESTS = 500

/** The timing of one benchmark: every batch in run order, and the fastest. */
export type Measurement = { batchesMs: number[]; bestMs: number; batchRequests: number }

/** Sizes for a benchmark whose operation is too slow for the defaults (a 25 MiB hash). */
export type MeasureOptions = { warmup?: number; batchRequests?: number; batches?: number }

/**
 * Times `BATCHES` batches of `BATCH_REQUESTS` calls of `operation` after a warm-up and returns
 * every batch time and the fastest. A benchmark gates on the fastest batch: a stalled batch (a
 * GC pause, a cold runner, a noisy neighbour) only makes that batch slower, while a real
 * regression makes every batch slower, so the best batch moves with regressions and not with noise.
 */
export async function measure(
  operation: (index: number) => unknown,
  options: MeasureOptions = {}
): Promise<Measurement> {
  const warmup = options.warmup ?? WARMUP_REQUESTS
  const batchRequests = options.batchRequests ?? BATCH_REQUESTS
  const batches = options.batches ?? BATCHES
  for (let index = 0; index < warmup; index++) {
    await operation(index)
  }
  const batchesMs: number[] = []
  for (let batch = 0; batch < batches; batch++) {
    const started = performance.now()
    for (let index = 0; index < batchRequests; index++) {
      await operation(index)
    }
    batchesMs.push(performance.now() - started)
  }
  return { batchesMs, bestMs: Math.min(...batchesMs), batchRequests }
}

/** One log line with the best and the median batch, for reading a trend in the CI log. */
export function summary(label: string, { batchesMs, bestMs, batchRequests }: Measurement): string {
  const median = [...batchesMs].sort((a, b) => a - b)[Math.floor(batchesMs.length / 2)] ?? bestMs
  const perRequest = (bestMs / batchRequests).toFixed(4)
  return `${label}: best ${bestMs.toFixed(1)} ms, median ${median.toFixed(1)} ms per ${batchRequests} requests (${perRequest} ms each)`
}
