import { describe, expect, it } from 'vitest'
import { extensionForMedia, mimeTypeForPath } from '../src/shared/media-types'

describe('shared media types', () => {
  it('recognizes supported document and audio paths case-insensitively', () => {
    expect(mimeTypeForPath('C:\\Documents\\Proposal.DOCX')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
    expect(mimeTypeForPath('/tmp/voice.WEBM')).toBe('video/webm')
    expect(mimeTypeForPath('/tmp/unknown.data')).toBe('application/octet-stream')
  })

  it('prefers a known MIME type and falls back to the original file extension', () => {
    expect(extensionForMedia('audio/webm; codecs=opus')).toBe('.webm')
    expect(extensionForMedia('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('.docx')
    expect(extensionForMedia('application/x-custom', 'Quarterly.Report.XLSX')).toBe('.xlsx')
    expect(extensionForMedia('application/x-custom')).toBe('.bin')
  })
})
