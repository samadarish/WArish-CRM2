import { closeSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import pino, { type Logger } from 'pino'
import type { LogEntryDto } from '../shared/contracts'

type CoreLogDestination = ReturnType<typeof pino.destination>
const loggerDestinations = new WeakMap<Logger, { destination: CoreLogDestination; ready: Promise<void> }>()
const MAX_RETAINED_LOG_BYTES = 64 * 1024 * 1024

export function createCoreLogger(logDirectory: string): Logger {
  mkdirSync(logDirectory, { recursive: true })
  pruneLogs(logDirectory)
  const date = new Date().toISOString().slice(0, 10)
  const destination = pino.destination({
    dest: join(logDirectory, `warish-${date}.log`),
    sync: false,
    mkdir: true,
    minLength: 4_096
  })
  const ready = new Promise<void>((resolve, reject) => {
    const onReady = (): void => { destination.off('error', onError); resolve() }
    const onError = (error: Error): void => { destination.off('ready', onReady); reject(error) }
    destination.once('ready', onReady)
    destination.once('error', onError)
  })
  const logger = pino(
    {
      level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
      base: { component: 'core' },
      redact: {
        paths: [
          'key', '*.key', 'keys', '*.keys', 'creds', '*.creds', 'auth', '*.auth',
          'message', '*.message', 'text', '*.text', 'body', '*.body',
          'phoneNumber', '*.phoneNumber', 'remoteJid', '*.remoteJid', 'participant', '*.participant',
          'chatId', '*.chatId', 'channelId', '*.channelId', 'messageId', '*.messageId',
          'attachmentToken', '*.attachmentToken', 'identityId', '*.identityId'
        ],
        censor: '[REDACTED]'
      }
    },
    destination
  )
  loggerDestinations.set(logger, { destination, ready })
  return logger
}

export async function flushCoreLogger(logger: Logger): Promise<void> {
  const runtime = loggerDestinations.get(logger)
  if (!runtime) {
    await new Promise<void>((resolve, reject) => logger.flush((error) => error ? reject(error) : resolve()))
    return
  }
  await runtime.ready
  await new Promise<void>((resolve, reject) => {
    logger.flush((error) => error ? reject(error) : resolve())
  })
  // SonicBoom's async callback can run before Windows exposes the write to a separate reader.
  runtime.destination.flushSync()
}

export async function closeCoreLogger(logger: Logger): Promise<void> {
  const runtime = loggerDestinations.get(logger)
  await flushCoreLogger(logger)
  if (!runtime) return
  await new Promise<void>((resolve, reject) => {
    const onClose = (): void => { runtime.destination.off('error', onError); resolve() }
    const onError = (error: Error): void => { runtime.destination.off('close', onClose); reject(error) }
    runtime.destination.once('close', onClose)
    runtime.destination.once('error', onError)
    runtime.destination.end()
  })
  loggerDestinations.delete(logger)
}

export function readErrorLogs(logDirectory: string, requestedLimit = 200): LogEntryDto[] {
  const limit = Math.min(Math.max(Math.floor(requestedLimit), 1), 500)
  let files: string[]
  try {
    files = readdirSync(logDirectory)
      .filter((name) => /^warish-\d{4}-\d{2}-\d{2}\.log$/.test(name))
      .sort()
      .reverse()
  } catch {
    return []
  }

  const entries: LogEntryDto[] = []
  for (const file of files) {
    let lines: string[]
    try { lines = readLogTail(join(logDirectory, file)).split(/\r?\n/).reverse() }
    catch { continue }
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line) as Record<string, unknown>
        const numericLevel = Number(record.level)
        if (!Number.isFinite(numericLevel) || numericLevel < 40) continue
        const context = formatLogContext(record)
        entries.push({
          timestamp: normalizeLogTimestamp(record.time),
          level: numericLevel >= 60 ? 'fatal' : numericLevel >= 50 ? 'error' : 'warning',
          message: typeof record.msg === 'string' && record.msg.trim() ? record.msg : 'Application error',
          ...(context ? { context } : {})
        })
        if (entries.length >= limit) return entries.sort((left, right) => right.timestamp - left.timestamp)
      } catch {
        // The logger may be writing the last line while diagnostics are read.
      }
    }
  }
  return entries.sort((left, right) => right.timestamp - left.timestamp)
}

function readLogTail(path: string): string {
  const handle = openSync(path, 'r')
  try {
    const size = fstatSync(handle).size
    const length = Math.min(size, 256 * 1024)
    const buffer = Buffer.alloc(length)
    readSync(handle, buffer, 0, length, size - length)
    const text = buffer.toString('utf8')
    return size > length ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    closeSync(handle)
  }
}

function formatLogContext(record: Record<string, unknown>): string | undefined {
  const details = Object.fromEntries(Object.entries(record).filter(([key]) =>
    !['level', 'time', 'msg', 'pid', 'hostname'].includes(key)
  ))
  if (!Object.keys(details).length) return undefined
  try {
    const value = JSON.stringify(details, null, 2)
    return value.length > 4_000 ? `${value.slice(0, 4_000)}\n…` : value
  } catch {
    return undefined
  }
}

function normalizeLogTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function pruneLogs(directory: string): void {
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
  const retained: Array<{ path: string; name: string; bytes: number }> = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith('warish-') || !entry.name.endsWith('.log')) continue
    const match = /^warish-(\d{4}-\d{2}-\d{2})\.log$/.exec(entry.name)
    const path = join(directory, entry.name)
    if (match?.[1] && new Date(`${match[1]}T00:00:00Z`).getTime() < cutoff) {
      rmSync(path, { force: true })
      continue
    }
    try { retained.push({ path, name: entry.name, bytes: statSync(path).size }) } catch { /* A transient log cannot block startup. */ }
  }

  retained.sort((left, right) => left.name.localeCompare(right.name))
  let totalBytes = retained.reduce((total, entry) => total + entry.bytes, 0)
  for (let index = 0; totalBytes > MAX_RETAINED_LOG_BYTES && index < retained.length - 1; index += 1) {
    const entry = retained[index]!
    try {
      rmSync(entry.path, { force: true })
      totalBytes -= entry.bytes
    } catch {
      // Diagnostics retention must never prevent the messaging core from starting.
    }
  }
}
