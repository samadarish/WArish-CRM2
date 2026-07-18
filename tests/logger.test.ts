import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
})
