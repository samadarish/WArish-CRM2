import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_CLIPBOARD_IMAGE_BYTES, saveClipboardImageDraft } from '../src/main/clipboard-image'

const directories: string[] = []

function temporaryUserData(): string {
  const directory = mkdtempSync(join(tmpdir(), 'warish-clipboard-image-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('clipboard image staging', () => {
  it.each([
    { mimeType: 'image/png; charset=binary', extension: '.png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01] },
    { mimeType: 'image/jpeg', extension: '.jpg', bytes: [0xff, 0xd8, 0xff, 0xe0] },
    { mimeType: 'image/webp', extension: '.webp', bytes: [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')] },
    { mimeType: 'image/gif', extension: '.gif', bytes: [...Buffer.from('GIF89a'), 0x01] }
  ])('writes a validated $extension draft with stable metadata', async ({ mimeType, extension, bytes }) => {
    const userDataPath = temporaryUserData()
    const data = Uint8Array.from(bytes)
    const picked = await saveClipboardImageDraft(userDataPath, data, mimeType)

    expect(picked).toMatchObject({ name: `Pasted image${extension}`, size: data.byteLength })
    expect(picked.token).toMatch(new RegExp(`\\${extension}$`))
    expect(picked.previewUrl).toBe(`warish-media://drafts/${encodeURIComponent(picked.token)}`)
    expect(readFileSync(join(userDataPath, 'drafts', picked.token))).toEqual(Buffer.from(data))
  })

  it.each([
    { label: 'empty data', data: new Uint8Array(), mimeType: 'image/png' },
    { label: 'an unsupported MIME type', data: Uint8Array.from([0x42, 0x4d, 0, 0]), mimeType: 'image/bmp' },
    { label: 'a mismatched signature', data: Uint8Array.from([0xff, 0xd8, 0xff]), mimeType: 'image/png' }
  ])('rejects $label without leaving a draft file', async ({ data, mimeType }) => {
    const userDataPath = temporaryUserData()
    await expect(saveClipboardImageDraft(userDataPath, data, mimeType)).rejects.toThrow()
    const drafts = join(userDataPath, 'drafts')
    expect(existsSync(drafts) ? readdirSync(drafts) : []).toEqual([])
  })

  it('rejects clipboard payloads above the in-memory limit', async () => {
    const userDataPath = temporaryUserData()
    const data = new Uint8Array(MAX_CLIPBOARD_IMAGE_BYTES + 1)
    data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await expect(saveClipboardImageDraft(userDataPath, data, 'image/png')).rejects.toThrow('limited to 25 MB')
    expect(existsSync(join(userDataPath, 'drafts'))).toBe(false)
  })
})
