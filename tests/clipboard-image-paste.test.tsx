// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { clipboardImageFiles } from '../src/renderer/src/clipboard-image'

function clipboardData(items: DataTransferItem[], files: File[] = []): DataTransfer {
  return { items, files } as unknown as DataTransfer
}

function clipboardItem(kind: DataTransferItem['kind'], type: string, file: File | null): DataTransferItem {
  return { kind, type, getAsFile: () => file } as DataTransferItem
}

describe('clipboard image extraction', () => {
  it('returns image file items without treating text as an attachment', () => {
    const image = new File(['image'], 'screenshot.png', { type: 'image/png' })
    const data = clipboardData([
      clipboardItem('string', 'text/plain', null),
      clipboardItem('file', 'image/png', image)
    ])
    expect(clipboardImageFiles(data)).toEqual([image])
  })

  it('falls back to clipboard files when item metadata is unavailable', () => {
    const image = new File(['image'], 'copied.webp', { type: 'image/webp' })
    expect(clipboardImageFiles(clipboardData([], [image]))).toEqual([image])
  })

  it('returns every image so the composer can reject multi-image paste explicitly', () => {
    const first = new File(['first'], 'first.png', { type: 'image/png' })
    const second = new File(['second'], 'second.jpg', { type: 'image/jpeg' })
    const data = clipboardData([
      clipboardItem('file', first.type, first),
      clipboardItem('file', second.type, second),
      clipboardItem('file', 'application/pdf', new File(['document'], 'quote.pdf', { type: 'application/pdf' }))
    ])
    expect(clipboardImageFiles(data)).toEqual([first, second])
  })

  it('leaves ordinary text and non-image files alone', () => {
    const document = new File(['document'], 'quote.pdf', { type: 'application/pdf' })
    const data = clipboardData([
      clipboardItem('string', 'text/plain', null),
      clipboardItem('file', document.type, document)
    ], [document])
    expect(clipboardImageFiles(data)).toEqual([])
  })
})
