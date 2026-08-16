import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { BufferJSON, downloadContentFromMessage, downloadMediaMessage, type WAMessage, type WASocket } from '@whiskeysockets/baileys'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WarishDatabase } from '../src/core/database'
import { MediaManager } from '../src/core/media-manager'
import { normalizeWhatsAppMessage } from '../src/core/normalizer'
import { DEFAULT_SETTINGS } from '../src/shared/contracts'

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>()
  return { ...actual, downloadContentFromMessage: vi.fn(), downloadMediaMessage: vi.fn() }
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

function createDocumentMessage(id: string): WAMessage {
  return {
    key: { id, remoteJid: '15550007777@s.whatsapp.net', fromMe: false },
    messageTimestamp: 1,
    message: { documentMessage: {
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName: 'Customer proposal.docx', fileLength: 8
    } }
  } as WAMessage
}

function setup(id = 'thumbnail-source', directPath = '/thumbnail.enc'): { database: WarishDatabase; media: MediaManager } {
  return setupMessage(createMediaMessage(id, directPath))
}

function setupMessage(message: WAMessage): { database: WarishDatabase; media: MediaManager } {
  const directory = mkdtempSync(join(tmpdir(), 'warish-media-test-'))
  directories.push(directory)
  const database = new WarishDatabase(join(directory, 'warish.sqlite'), Buffer.alloc(32, 7), pino({ enabled: false }))
  const normalized = normalizeWhatsAppMessage(message).message
  if (!normalized) throw new Error('Fixture media message was not normalized')
  database.storeMessage(normalized)
  return { database, media: new MediaManager(directory, database, pino({ enabled: false })) }
}

afterEach(() => {
  vi.mocked(downloadContentFromMessage).mockReset()
  vi.mocked(downloadMediaMessage).mockReset()
  vi.restoreAllMocks()
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('MediaManager', () => {
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

  it('keeps active partial downloads out of cache eviction', () => {
    const { database, media } = setup('active-partial')
    const partialPath = media.resolveCache('active-download.part')
    writeFileSync(partialPath, Buffer.alloc(16, 1))

    media.enforceLimit(0)

    expect(existsSync(partialPath)).toBe(true)
    database.close()
  })

  it('protects every ordered draft attachment while removing orphan draft files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'warish-media-test-'))
    directories.push(directory)
    const database = new WarishDatabase(join(directory, 'warish.sqlite'), Buffer.alloc(32, 7), pino({ enabled: false }))
    const chatId = '15550008888@s.whatsapp.net'
    database.upsertChat({ id: chatId, title: 'Album draft', kind: 'direct' })
    database.saveDraft({
      chatId,
      text: 'Two images',
      attachments: [
        { token: 'first.png', kind: 'image', name: 'First.png', size: 5, mimeType: 'image/png',
          previewUrl: 'warish-media://drafts/first.png' },
        { token: 'second.jpg', kind: 'image', name: 'Second.jpg', size: 6, mimeType: 'image/jpeg',
          previewUrl: 'warish-media://drafts/second.jpg' }
      ],
      updatedAt: Date.now()
    })
    const draftsDirectory = join(directory, 'drafts')
    mkdirSync(draftsDirectory, { recursive: true })
    writeFileSync(join(draftsDirectory, 'first.png'), 'first')
    writeFileSync(join(draftsDirectory, 'second.jpg'), 'second')
    writeFileSync(join(draftsDirectory, 'orphan.webp'), 'orphan')

    const media = new MediaManager(directory, database, pino({ enabled: false }))

    expect(existsSync(media.resolveDraft('first.png'))).toBe(true)
    expect(existsSync(media.resolveDraft('second.jpg'))).toBe(true)
    expect(existsSync(media.resolveDraft('orphan.webp'))).toBe(false)
    database.close()
  })

  it('stops oversized downloads at the configured limit and removes the partial file', async () => {
    const { database, media } = setup('oversized-download')
    vi.spyOn(database, 'getSettings').mockReturnValue({ ...DEFAULT_SETTINGS, cacheLimitBytes: 4 })
    vi.mocked(downloadMediaMessage).mockResolvedValue(Readable.from([Buffer.alloc(5, 1)]) as never)

    await expect(media.download('oversized-download', { updateMediaMessage: vi.fn() } as unknown as WASocket))
      .rejects.toThrow('larger than the configured cache limit')

    expect(readdirSync(media.mediaDirectory).filter((name) => name.endsWith('.part'))).toEqual([])
    expect(database.getMessage('oversized-download').attachment?.downloadState).toBe('failed')
    database.close()
  })

  it('preserves the original document extension in the content-addressed cache', async () => {
    const { database, media } = setupMessage(createDocumentMessage('document-download'))
    vi.mocked(downloadMediaMessage).mockResolvedValue(Readable.from([Buffer.from('document')]) as never)

    const token = await media.download('document-download', { updateMediaMessage: vi.fn() } as unknown as WASocket)

    expect(token).toMatch(/^[a-f0-9]{64}\.docx$/)
    expect(database.getMessage('document-download').attachment).toMatchObject({ cacheToken: token, downloadState: 'ready' })
    expect(existsSync(media.resolveCache(token))).toBe(true)
    database.close()
  })
})
