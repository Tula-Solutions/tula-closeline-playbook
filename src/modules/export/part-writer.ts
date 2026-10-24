import type { Container } from '~/container'

/** What the part writer needs from the container. */
export type PartWriterDeps = Pick<Container, 'objects'>

/** The most bytes one NDJSON file holds before it is written and a new one starts. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024

/** The most bytes one copied original may hold (the largest file the Playbook accepts is far below). */
export const MAX_COPY_BYTES = 600 * 1024 * 1024

/** The totals of what a part wrote. */
export type PartTotals = { files: number; bytes: number }

/**
 * Writes one export part: NDJSON rows buffered per dataset and flushed as numbered files under the
 * part's prefix, and copied originals. Memory is one buffer per dataset (at most
 * {@link MAX_FILE_BYTES} plus one row), whatever the Organization's size. Keys are a function of
 * the dataset and the row order, so writing the same part again replaces the same objects.
 */
export class PartWriter {
  private readonly buffers = new Map<string, { lines: string[]; bytes: number; chunk: number }>()
  private readonly totals: PartTotals = { files: 0, bytes: 0 }
  private readonly encoder = new TextEncoder()

  constructor(
    private readonly deps: PartWriterDeps,
    private readonly organizationId: string,
    private readonly prefix: string,
    private readonly rowsPerFile: number
  ) {}

  /** Adds one row to a dataset and writes the file when it is full. */
  async row(dataset: string, value: unknown): Promise<void> {
    const line = `${JSON.stringify(value)}\n`
    const buffer = this.buffers.get(dataset) ?? { lines: [], bytes: 0, chunk: 0 }
    this.buffers.set(dataset, buffer)
    buffer.lines.push(line)
    buffer.bytes += line.length
    if (buffer.lines.length >= this.rowsPerFile || buffer.bytes >= MAX_FILE_BYTES) {
      await this.flush(dataset)
    }
  }

  /** Writes what every dataset still holds. */
  async finish(): Promise<PartTotals> {
    for (const dataset of [...this.buffers.keys()]) {
      await this.flush(dataset)
    }
    return { ...this.totals }
  }

  /** Copies one stored object into the part, streamed; returns false when the source is missing. */
  async copy(sourceKey: string, relativeKey: string, contentType: string): Promise<boolean> {
    const source = await this.deps.objects.getStream(this.organizationId, sourceKey)
    if (source === undefined) {
      return false
    }
    try {
      const result = await this.deps.objects.putStream(
        this.organizationId,
        `${this.prefix}/${relativeKey}`,
        source.body,
        { maxBytes: MAX_COPY_BYTES, contentType }
      )
      this.totals.files += 1
      this.totals.bytes += result.size
      return true
    } catch (error) {
      await source.body.cancel().catch(() => undefined)
      throw error
    }
  }

  private async flush(dataset: string): Promise<void> {
    const buffer = this.buffers.get(dataset)
    if (buffer === undefined || buffer.lines.length === 0) {
      return
    }
    buffer.chunk += 1
    const body = this.encoder.encode(buffer.lines.join(''))
    buffer.lines = []
    buffer.bytes = 0
    const name = `${dataset}-${String(buffer.chunk).padStart(4, '0')}.ndjson`
    await this.deps.objects.put(this.organizationId, `${this.prefix}/${name}`, body, {
      contentType: 'application/x-ndjson',
    })
    this.totals.files += 1
    this.totals.bytes += body.byteLength
  }
}
