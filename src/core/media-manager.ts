import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { basename, join, resolve } from 'node:path'
import { downloadContentFromMessage, downloadMediaMessage, normalizeMessageContent, type WASocket } from '@whiskeysockets/baileys'
import type { Logger } from 'pino'
import { extensionForMedia } from '../shared/media-types'
import { WarishDatabase } from './database'
import { deserializeRawMessage } from './normalizer'

export class MediaManager {
  readonly mediaDirectory: string
  readonly draftsDirectory: string
  readonly avatarsDirectory: string
  readonly #database: WarishDatabase
  readonly #logger: Logger
  readonly #downloads = new Map<string, AbortController>()
  readonly #downloadPromises = new Map<string, Promise<string>>()
  readonly #thumbnailPromises = new Map<string, Promise<string | undefined>>()
  readonly #thumbnailQueue: Array<() => void> = []
  #activeThumbnailRequests = 0

  constructor(userDataPath: string, database: WarishDatabase, logger: Logger) {
    this.mediaDirectory = join(userDataPath, 'media')
    this.draftsDirectory = join(userDataPath, 'drafts')
    this.avatarsDirectory = join(userDataPath, 'avatars')
    this.#database = database
    this.#logger = logger
    mkdirSync(this.mediaDirectory, { recursive: true })
    mkdirSync(this.draftsDirectory, { recursive: true })
    mkdirSync(this.avatarsDirectory, { recursive: true })
    this.cleanOrphanDrafts()
  }

  resolveDraft(token: string): string {
    return safeChildPath(this.draftsDirectory, token)
  }

  resolveCache(token: string): string {
    return safeChildPath(this.mediaDirectory, token)
  }

  resolveAvatar(token: string): string {
    return safeChildPath(this.avatarsDirectory, token)
  }

  async downloadAvatar(url: string): Promise<string> {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`Profile image request failed (${response.status})`)
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (!mimeType?.startsWith('image/')) throw new Error('Profile image response was not an image')
    const declaredSize = Number(response.headers.get('content-length') ?? 0)
    if (declaredSize > 5 * 1024 * 1024) throw new Error('Profile image is too large')
    const data = Buffer.from(await response.arrayBuffer())
    if (!data.length || data.length > 5 * 1024 * 1024) throw new Error('Profile image is empty or too large')
    const extension = avatarExtension(mimeType)
    if (!extension || !hasImageSignature(data, mimeType)) throw new Error('Profile image format is not supported')
    const token = `avatar-${createHash('sha256').update(data).digest('hex')}${extension}`
    const path = this.resolveAvatar(token)
    if (!existsSync(path)) {
      try { writeFileSync(path, data, { flag: 'wx' }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    return token
  }

  async download(messageId: string, socket: WASocket): Promise<string> {
    const existing = this.#database.getMessage(messageId).attachment?.cacheToken
    if (existing && existsSync(this.resolveCache(existing))) return existing
    if (existing) this.#database.clearMediaToken(messageId)
    const pending = this.#downloadPromises.get(messageId)
    if (pending) return pending
    const promise = this.#download(messageId, socket)
    this.#downloadPromises.set(messageId, promise)
    try { return await promise }
    finally { this.#downloadPromises.delete(messageId) }
  }

  async thumbnail(messageId: string): Promise<string | undefined> {
    const attachment = this.#database.getMessage(messageId).attachment
    if (attachment?.thumbnailDataUrl) return attachment.thumbnailDataUrl
    if (!this.#database.shouldFetchMediaThumbnail(messageId)) return undefined
    const pending = this.#thumbnailPromises.get(messageId)
    if (pending) return pending
    const promise = this.#enqueueThumbnailTask(() => this.#downloadThumbnail(messageId))
    this.#thumbnailPromises.set(messageId, promise)
    try { return await promise }
    finally { this.#thumbnailPromises.delete(messageId) }
  }

  async #downloadThumbnail(messageId: string): Promise<string | undefined> {
    const raw = this.#database.getRawMessage(messageId)
    if (!raw) {
      this.#database.markMediaThumbnailUnavailable(messageId, 24 * 60 * 60 * 1000)
      return undefined
    }
    const message = deserializeRawMessage(raw)
    const content = normalizeMessageContent(message.message)
    const attachment = content?.imageMessage ?? content?.videoMessage
    const kind = content?.imageMessage ? 'thumbnail-image' : content?.videoMessage ? 'thumbnail-video' : undefined
    if (!attachment?.thumbnailDirectPath || !attachment.mediaKey || !kind) {
      this.#database.markMediaThumbnailUnavailable(messageId, 24 * 60 * 60 * 1000)
      return undefined
    }
    try {
      const stream = await downloadContentFromMessage(
        { directPath: attachment.thumbnailDirectPath, mediaKey: attachment.mediaKey },
        kind,
        { options: { signal: AbortSignal.timeout(10_000) } }
      )
      const data = await readStreamWithLimit(stream, 256 * 1024)
      const mimeType = imageMimeType(data)
      if (!mimeType) throw new Error('Media thumbnail was not a supported image')
      const dataUrl = `data:${mimeType};base64,${data.toString('base64')}`
      this.#database.saveMediaThumbnail(messageId, dataUrl)
      return dataUrl
    } catch (error) {
      this.#database.markMediaThumbnailUnavailable(messageId, 5 * 60 * 1000)
      this.#logger.warn({ messageId, reason: errorDetails(error) }, 'media thumbnail request failed')
      return undefined
    }
  }

  #enqueueThumbnailTask(task: () => Promise<string | undefined>): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve, reject) => {
      const run = (): void => {
        this.#activeThumbnailRequests += 1
        void task().then(resolve, reject).finally(() => {
          this.#activeThumbnailRequests -= 1
          this.#thumbnailQueue.shift()?.()
        })
      }
      if (this.#activeThumbnailRequests < 4) run()
      else this.#thumbnailQueue.push(run)
    })
  }

  async #download(messageId: string, socket: WASocket): Promise<string> {
    const raw = this.#database.getRawMessage(messageId)
    if (!raw) throw new Error('The encrypted source message is unavailable')

    const controller = new AbortController()
    this.#downloads.set(messageId, controller)
    this.#database.setMediaDownloadState(messageId, 'downloading')
    const partialToken = `${randomUUID()}.part`
    const partialPath = this.resolveCache(partialToken)
    try {
      const message = deserializeRawMessage(raw)
      const stream = await downloadMediaMessage(
        message,
        'stream',
        { options: { signal: controller.signal } },
        { logger: this.#logger, reuploadRequest: socket.updateMediaMessage }
      )
      const hash = createHash('sha256')
      let size = 0
      const cacheLimitBytes = this.#database.getSettings().cacheLimitBytes
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length
          if (size > cacheLimitBytes) {
            callback(new Error('This media file is larger than the configured cache limit'))
            return
          }
          hash.update(chunk)
          callback(null, chunk)
        }
      })
      await pipeline(stream, meter, createWriteStream(partialPath, { flags: 'wx' }))
      if (controller.signal.aborted) throw new Error('Media download cancelled')
      const attachment = this.#database.getMessage(messageId).attachment
      const extension = extensionForMedia(attachment?.mimeType, attachment?.fileName)
      const token = `${hash.digest('hex')}${extension}`
      const finalPath = this.resolveCache(token)
      if (existsSync(finalPath)) rmSync(partialPath, { force: true })
      else renameSync(partialPath, finalPath)
      this.#database.saveMediaToken(messageId, token, size)
      this.enforceLimit(cacheLimitBytes)
      if (!existsSync(finalPath)) throw new Error('This media file is larger than the configured cache limit')
      return token
    } catch (error) {
      rmSync(partialPath, { force: true })
      this.#database.setMediaDownloadState(messageId, 'failed')
      throw error
    } finally {
      this.#downloads.delete(messageId)
    }
  }

  cancel(messageId: string): void {
    this.#downloads.get(messageId)?.abort()
  }

  clear(): void {
    for (const controller of this.#downloads.values()) controller.abort()
    const tokens: string[] = []
    for (const entry of readdirSync(this.mediaDirectory, { withFileTypes: true })) {
      if (entry.isFile()) rmSync(join(this.mediaDirectory, entry.name), { force: true })
      if (entry.isFile() && !entry.name.endsWith('.part')) tokens.push(entry.name)
    }
    this.#database.clearMediaTokens(tokens.length ? tokens : undefined)
    for (const entry of readdirSync(this.avatarsDirectory, { withFileTypes: true })) {
      if (entry.isFile()) rmSync(join(this.avatarsDirectory, entry.name), { force: true })
    }
    this.#database.clearContactAvatarTokens()
  }

  discardDraft(token: string): void {
    rmSync(this.resolveDraft(token), { force: true })
  }

  cleanOrphanDrafts(): void {
    const referenced = this.#database.referencedDraftTokens()
    for (const entry of readdirSync(this.draftsDirectory, { withFileTypes: true })) {
      if (entry.isFile() && !referenced.has(entry.name)) rmSync(join(this.draftsDirectory, entry.name), { force: true })
    }
  }

  sizeBytes(): number {
    let size = 0
    for (const entry of readdirSync(this.mediaDirectory, { withFileTypes: true })) {
      if (entry.isFile()) size += statSync(join(this.mediaDirectory, entry.name)).size
    }
    for (const entry of readdirSync(this.avatarsDirectory, { withFileTypes: true })) {
      if (entry.isFile()) size += statSync(join(this.avatarsDirectory, entry.name)).size
    }
    return size
  }

  avatarSizeBytes(): number {
    let size = 0
    for (const entry of readdirSync(this.avatarsDirectory, { withFileTypes: true })) {
      if (entry.isFile()) size += statSync(join(this.avatarsDirectory, entry.name)).size
    }
    return size
  }

  enforceLimit(limitBytes: number): void {
    const files = readdirSync(this.mediaDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.endsWith('.part'))
      .map((entry) => {
        const path = join(this.mediaDirectory, entry.name)
        const stat = statSync(path)
        return { path, size: stat.size, touched: Math.max(stat.atimeMs, stat.mtimeMs) }
      })
      .sort((a, b) => a.touched - b.touched)
    let total = files.reduce((sum, file) => sum + file.size, 0)
    const evicted: string[] = []
    for (const file of files) {
      if (total <= limitBytes) break
      rmSync(file.path, { force: true })
      total -= file.size
      evicted.push(basename(file.path))
    }
    this.#database.clearMediaTokens(evicted)
  }
}

function safeChildPath(parent: string, token: string): string {
  if (basename(token) !== token) throw new Error('Invalid media token')
  const result = resolve(parent, token)
  if (!result.startsWith(`${resolve(parent)}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Invalid media path')
  return result
}

function avatarExtension(mime: string): string | undefined {
  const extensions: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif'
  }
  return extensions[mime]
}

async function readStreamWithLimit(stream: AsyncIterable<Uint8Array | string>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += data.length
    if (size > limit) throw new Error('Media thumbnail is too large')
    chunks.push(data)
  }
  if (!size) throw new Error('Media thumbnail is empty')
  return Buffer.concat(chunks, size)
}

function imageMimeType(data: Buffer): string | undefined {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

function errorDetails(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const code = (error as NodeJS.ErrnoException).code
  return code ? `${error.message} (${code})` : error.message
}

function hasImageSignature(data: Buffer, mime: string): boolean {
  if (mime === 'image/jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
  if (mime === 'image/png') return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (mime === 'image/webp') return data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP'
  if (mime === 'image/gif') return data.subarray(0, 4).toString('ascii') === 'GIF8'
  return false
}
