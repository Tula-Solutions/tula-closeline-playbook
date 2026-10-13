import { expect, test } from 'bun:test'
import { ocrBehaviour } from '~/ports/ocr.behaviour'
import { createEmptyOcrReader, createMemoryOcrReader } from './ocr'

ocrBehaviour('memory OCR reader', () => createMemoryOcrReader())

test('the memory OCR reader reads a page as text naming it, and records the call', async () => {
  const reader = createMemoryOcrReader()

  const pages = await reader.recognise(
    { bytes: new Uint8Array([1]), mediaType: 'application/pdf', pages: [2] },
    { signal: new AbortController().signal }
  )

  expect(pages).toEqual([{ number: 2, text: 'ocr text of page 2' }])
  expect(reader.calls).toEqual([{ pages: [2] }])
})

ocrBehaviour('empty OCR reader', () => createEmptyOcrReader())

test('the empty OCR reader reads every asked page as empty text', async () => {
  const read = await createEmptyOcrReader().recognise(
    { bytes: new Uint8Array(), mediaType: 'application/pdf', pages: [2, 5] },
    { signal: new AbortController().signal }
  )
  expect(read).toEqual([
    { number: 2, text: '' },
    { number: 5, text: '' },
  ])
})
