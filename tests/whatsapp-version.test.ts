import type { WAVersion } from '@whiskeysockets/baileys'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import {
  WhatsAppWebVersionResolver,
  type WhatsAppWebVersionFetcher
} from '../src/core/whatsapp-version'

function createLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn() } as unknown as Logger
}

describe('WhatsAppWebVersionResolver', () => {
  it('shares and caches a successful lookup until it is invalidated', async () => {
    const first: WAVersion = [2, 3000, 1044017588]
    const second: WAVersion = [2, 3000, 1044017999]
    const fetchVersion = vi.fn<WhatsAppWebVersionFetcher>()
      .mockResolvedValueOnce({ version: first, isLatest: true })
      .mockResolvedValueOnce({ version: second, isLatest: true })
    const resolver = new WhatsAppWebVersionResolver(createLogger(), fetchVersion)

    const [left, right] = await Promise.all([resolver.resolve(), resolver.resolve()])

    expect(left).toEqual(first)
    expect(right).toEqual(first)
    expect(fetchVersion).toHaveBeenCalledOnce()
    expect(fetchVersion.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(await resolver.resolve()).toEqual(first)
    expect(fetchVersion).toHaveBeenCalledOnce()

    resolver.invalidate()
    expect(await resolver.resolve()).toEqual(second)
    expect(fetchVersion).toHaveBeenCalledTimes(2)
  })

  it('uses but does not cache the bundled fallback when live resolution fails', async () => {
    const fallback: WAVersion = [2, 3000, 1035194821]
    const error = new Error('version endpoint unavailable')
    const fetchVersion = vi.fn<WhatsAppWebVersionFetcher>()
      .mockResolvedValue({ version: fallback, isLatest: false, error })
    const logger = createLogger()
    const resolver = new WhatsAppWebVersionResolver(logger, fetchVersion)

    expect(await resolver.resolve()).toEqual(fallback)
    expect(await resolver.resolve()).toEqual(fallback)

    expect(fetchVersion).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith(
      { error, fallbackVersion: '2.3000.1035194821' },
      'could not resolve current WhatsApp Web version; using the bundled fallback'
    )
  })
})
