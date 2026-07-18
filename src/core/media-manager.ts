import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { basename, extname, join, resolve } from 'node:path'
import { downloadMediaMessage, type WASocket } from '@whiskeysockets/baileys'
import type { Logger } from 'pino'
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
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length
          hash.update(chunk)
          callback(null, chunk)
        }
      })
      await pipeline(stream, meter, createWriteStream(partialPath, { flags: 'wx' }))
      if (controller.signal.aborted) throw new Error('Media download cancelled')
      const extension = extensionForMime(this.#database.getMessage(messageId).attachment?.mimeType)
      const token = `${hash.digest('hex')}${extension}`
      const finalPath = this.resolveCache(token)
      if (existsSync(finalPath)) rmSync(partialPath, { force: true })
      else renameSync(partialPath, finalPath)
      this.#database.saveMediaToken(messageId, token, size)
      this.enforceLimit(this.#database.getSettings().cacheLimitBytes)
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
      .filter((entry) => entry.isFile())
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

function extensionForMime(mime?: string): string {
  const clean = mime?.split(';')[0]?.trim()
  const map: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a', 'application/pdf': '.pdf'
  }
  return map[clean ?? ''] ?? (extname(clean ?? '') || '.bin')
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

function hasImageSignature(data: Buffer, mime: string): boolean {
  if (mime === 'image/jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
  if (mime === 'image/png') return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (mime === 'image/webp') return data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP'
  if (mime === 'image/gif') return data.subarray(0, 4).toString('ascii') === 'GIF8'
  return false
}
