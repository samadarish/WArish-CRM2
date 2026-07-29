import { fetchLatestWaWebVersion, type WAVersion } from '@whiskeysockets/baileys'
import type { Logger } from 'pino'

const VERSION_LOOKUP_TIMEOUT_MS = 10_000

export type WhatsAppWebVersionFetcher = typeof fetchLatestWaWebVersion

export class WhatsAppWebVersionResolver {
  readonly #logger: Logger
  readonly #fetchVersion: WhatsAppWebVersionFetcher
  #cached?: WAVersion
  #pending?: Promise<WAVersion>

  constructor(logger: Logger, fetchVersion: WhatsAppWebVersionFetcher = fetchLatestWaWebVersion) {
    this.#logger = logger
    this.#fetchVersion = fetchVersion
  }

  async resolve(): Promise<WAVersion> {
    if (this.#cached) return this.#cached
    if (this.#pending) return this.#pending
    const pending = this.#lookup()
    this.#pending = pending
    try { return await pending }
    finally { if (this.#pending === pending) this.#pending = undefined }
  }

  invalidate(): void {
    this.#cached = undefined
  }

  async #lookup(): Promise<WAVersion> {
    const result = await this.#fetchVersion({ signal: AbortSignal.timeout(VERSION_LOOKUP_TIMEOUT_MS) })
    const version = result.version.join('.')
    if (result.isLatest) {
      this.#cached = result.version
      this.#logger.info({ version }, 'resolved current WhatsApp Web version')
    } else {
      this.#logger.warn({ error: result.error, fallbackVersion: version },
        'could not resolve current WhatsApp Web version; using the bundled fallback')
    }
    return result.version
  }
}
