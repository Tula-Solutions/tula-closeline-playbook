// Stand-ins for a parser that goes wrong, for the host's tests: each mode is the first line of the message.
declare const self: {
  onmessage: ((event: MessageEvent<{ mediaType: string }>) => void) | null
  postMessage(message: unknown): void
}

self.onmessage = (event) => {
  const mode = event.data.mediaType
  if (mode === 'spin') {
    while (true) {
      // Never yields.
    }
  } else if (mode === 'oom') {
    const kept: Uint8Array[] = []
    while (true) {
      kept.push(new Uint8Array(32 * 1024 * 1024).fill(1))
    }
  } else if (mode === 'throw') {
    throw new Error('SECRET-FILE-CONTENT')
  } else if (mode === 'exit') {
    process.exit(3)
  } else if (mode === 'document-not-an-object') {
    self.postMessage({ ok: true, document: 7 })
  } else if (mode === 'unknown-reason') {
    self.postMessage({ ok: false, reason: 'x' })
  } else if (mode === 'too-many-pages') {
    const pages = Array.from({ length: 400 }, (_v, i) => ({
      number: i + 1,
      text: 'a',
      needsOcr: false,
    }))
    self.postMessage({ ok: true, document: { pages } })
  } else if (mode === 'too-much-text') {
    self.postMessage({
      ok: true,
      document: { pages: [{ number: 1, text: 'a'.repeat(6_000_000), needsOcr: false }] },
    })
  } else if (mode === 'bad-page') {
    self.postMessage({
      ok: true,
      document: { pages: [{ number: 1.5, text: 'a', needsOcr: 'yes' }] },
    })
  } else if (mode === 'bad-page-count') {
    self.postMessage({ ok: false, reason: 'too_many_pages', pageCount: -3 })
  } else if (mode === 'garbage') {
    self.postMessage('not a reply')
  } else {
    self.postMessage({
      ok: true,
      document: { pages: [{ number: 1, text: 'fine', needsOcr: false }] },
    })
  }
}
