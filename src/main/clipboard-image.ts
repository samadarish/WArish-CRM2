import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PickedAttachment } from '../shared/contracts'

export const MAX_CLIPBOARD_IMAGE_BYTES = 25 * 1024 * 1024

interface ClipboardImageFormat {
  extension: '.gif' | '.jpg' | '.png' | '.webp'
  mimeType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp'
  matches(data: Buffer): boolean
}

const CLIPBOARD_IMAGE_FORMATS: readonly ClipboardImageFormat[] = [
  {
    extension: '.png',
    mimeType: 'image/png',
    matches: (data) => data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  },
  {
    extension: '.jpg',
    mimeType: 'image/jpeg',
    matches: (data) => data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
  },
  {
    extension: '.webp',
    mimeType: 'image/webp',
    matches: (data) => data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP'
  },
  {
    extension: '.gif',
    mimeType: 'image/gif',
    matches: (data) => data.length >= 6 && (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a')
  }
]

export async function saveClipboardImageDraft(
  userDataPath: string,
  data: unknown,
  mimeType: unknown
): Promise<PickedAttachment> {
  if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new Error('The pasted image is empty')
  if (data.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error('Pasted images are limited to 25 MB')
  if (typeof mimeType !== 'string') throw new Error('The pasted image format is not supported')

  const normalizedMimeType = mimeType.split(';', 1)[0]?.trim().toLowerCase()
  const format = CLIPBOARD_IMAGE_FORMATS.find((candidate) => candidate.mimeType === normalizedMimeType)
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (!format || !format.matches(bytes)) throw new Error('The pasted image format is not supported')

  const draftsDirectory = join(userDataPath, 'drafts')
  await mkdir(draftsDirectory, { recursive: true })
  const token = `${randomUUID()}${format.extension}`
  const path = join(draftsDirectory, token)
  try {
    await writeFile(path, bytes, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') await rm(path, { force: true }).catch(() => undefined)
    throw error
  }

  return {
    token,
    name: `Pasted image${format.extension}`,
    size: bytes.byteLength,
    mimeType: format.mimeType,
    previewUrl: `warish-media://drafts/${encodeURIComponent(token)}`
  }
}
