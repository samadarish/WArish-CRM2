import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { BufferJSON, downloadContentFromMessage, type WAMessage } from '@whiskeysockets/baileys'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WarishDatabase } from '../src/core/database'
import { MediaManager } from '../src/core/media-manager'
import { normalizeWhatsAppMessage } from '../src/core/normalizer'

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>()
  return { ...actual, downloadContentFromMessage: vi.fn() }
})

const directories: string[] = []

function createMediaMessage(id: string, thumbnailDirectPath?: string): WAMessage {
  return JSON.parse(JSON.stringify({
    key: { id, remoteJid: '15550007777@s.whatsapp.net', fromMe: false },
    messageTimestamp: 1,
    message: { imageMessage: {
      mimetype: 'image/jpeg', width: 1200, height: 800, mediaKey: Buffer.alloc(32, 4), thumbnailDirectPath
    } }
  }, BufferJSON.replacer), BufferJSON.reviver) as WAMessage
}

function setup(id = 'thumbnail-source', directPath = '/thumbnail.enc'): { database: WarishDatabase; media: MediaManager } {
  const directory = mkdtempSync(join(tmpdir(), 'warish-media-test-'))
  directories.push(directory)
  const database = new WarishDatabase(join(directory, 'warish.sqlite'), Buffer.alloc(32, 7), pino({ enabled: false }))
  const normalized = normalizeWhatsAppMessage(createMediaMessage(id, directPath)).message
  if (!normalized) throw new Error('Fixture media message was not normalized')
  database.storeMessage(normalized)
  return { database, media: new MediaManager(directory, database, pino({ enabled: false })) }
}

afterEach(() => {
  vi.mocked(downloadContentFromMessage).mockReset()
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('MediaManager thumbnails', () => {
  it('decrypts, deduplicates, and persists a small visible-media thumbnail', async () => {
    const { database, media } = setup()
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0xff, 0xd9])
    vi.mocked(downloadContentFromMessage).mockResolvedValue(Readable.from([jpeg]) as never)

    const [first, second] = await Promise.all([media.thumbnail('thumbnail-source'), media.thumbnail('thumbnail-source')])

    expect(first).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`)
    expect(second).toBe(first)
    expect(downloadContentFromMessage).toHaveBeenCalledOnce()
    expect(database.getMessage('thumbnail-source').attachment?.thumbnailDataUrl).toBe(first)
    expect(await media.thumbnail('thumbnail-source')).toBe(first)
    expect(downloadContentFromMessage).toHaveBeenCalledOnce()
    database.close()
  })

  it('caps oversized thumbnail responses and records a retry backoff', async () => {
    const { database, media } = setup('oversized-thumbnail')
    vi.mocked(downloadContentFromMessage).mockResolvedValue(Readable.from([Buffer.alloc(256 * 1024 + 1, 1)]) as never)

    expect(await media.thumbnail('oversized-thumbnail')).toBeUndefined()
    expect(database.shouldFetchMediaThumbnail('oversized-thumbnail')).toBe(false)
    expect(database.getMessage('oversized-thumbnail').attachment?.thumbnailDataUrl).toBeUndefined()
    database.close()
  })

  it('negative-caches messages that have no downloadable thumbnail path', async () => {
    const { database, media } = setup('missing-thumbnail', '')

    expect(await media.thumbnail('missing-thumbnail')).toBeUndefined()
    expect(downloadContentFromMessage).not.toHaveBeenCalled()
    expect(database.shouldFetchMediaThumbnail('missing-thumbnail')).toBe(false)
    database.close()
  })
})
