import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeCoreLogger, createCoreLogger, flushCoreLogger, readErrorLogs } from '../src/core/logger'

const directories: string[] = []

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('readErrorLogs', () => {
  it('returns recent warnings and errors while ignoring info and incomplete lines', () => {
    const directory = mkdtempSync(join(tmpdir(), 'warish-logs-'))
    directories.push(directory)
    writeFileSync(join(directory, 'warish-2026-07-15.log'), [
      JSON.stringify({ level: 30, time: 100, msg: 'ordinary information' }),
      JSON.stringify({ level: 40, time: 200, msg: 'temporary issue', component: 'baileys' }),
      JSON.stringify({ level: 50, time: 300, msg: 'request failed', error: { message: 'redacted failure' } }),
      '{"level":50'
    ].join('\n'))

    expect(readErrorLogs(directory, 20)).toEqual([
      expect.objectContaining({ timestamp: 300, level: 'error', message: 'request failed' }),
      expect.objectContaining({ timestamp: 200, level: 'warning', message: 'temporary issue' })
    ])
    expect(readErrorLogs(directory, 1)).toHaveLength(1)
  })

  it('flushes asynchronous logger output before diagnostics read it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'warish-logs-'))
    directories.push(directory)
    const logger = createCoreLogger(directory)
    logger.warn({ safeContext: 'test' }, 'a flushed warning')

    await flushCoreLogger(logger)
    const entries = readErrorLogs(directory, 20)
    await closeCoreLogger(logger)

    expect(entries).toEqual([
      expect.objectContaining({ level: 'warning', message: 'a flushed warning' })
    ])
  })

  it('redacts customer and message identifiers from diagnostic context', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'warish-logs-'))
    directories.push(directory)
    const logger = createCoreLogger(directory)
    logger.warn({
      chatId: 'private-chat',
      phoneNumber: '+919999999999',
      nested: { messageId: 'private-message' },
      safeContext: 'visible detail'
    }, 'a safe warning')

    await flushCoreLogger(logger)
    const [entry] = readErrorLogs(directory, 20)
    await closeCoreLogger(logger)

    expect(entry?.context).toContain('[REDACTED]')
    expect(entry?.context).toContain('visible detail')
    expect(entry?.context).not.toContain('private-chat')
    expect(entry?.context).not.toContain('+919999999999')
    expect(entry?.context).not.toContain('private-message')
  })

  it('removes the oldest daily logs when retained diagnostics exceed 64 MB', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'warish-logs-'))
    directories.push(directory)
    const oldest = join(directory, datedLogName(2))
    const recent = join(directory, datedLogName(1))
    writeFileSync(oldest, '')
    writeFileSync(recent, '')
    truncateSync(oldest, 34 * 1024 * 1024)
    truncateSync(recent, 34 * 1024 * 1024)

    const logger = createCoreLogger(directory)
    await closeCoreLogger(logger)

    expect(existsSync(oldest)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })
})

function datedLogName(daysAgo: number): string {
  return `warish-${new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}.log`
}
