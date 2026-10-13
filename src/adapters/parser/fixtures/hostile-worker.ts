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
  } else if (mode === 'garbage') {
    self.postMessage('not a reply')
  } else {
    self.postMessage({
      ok: true,
      document: { pages: [{ number: 1, text: 'fine', needsOcr: false }] },
    })
  }
}
