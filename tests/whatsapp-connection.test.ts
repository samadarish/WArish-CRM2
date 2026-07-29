import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import makeWASocket, {
  fetchLatestWaWebVersion,
  type WAVersion,
  type WASocket
} from '@whiskeysockets/baileys'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistentAuthState } from '../src/core/auth-store'
import { CrmRepository } from '../src/core/crm-repository'
import { WarishDatabase } from '../src/core/database'
import type { MediaManager } from '../src/core/media-manager'
import { WhatsAppClient } from '../src/core/whatsapp-client'

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>()
  return { ...actual, default: vi.fn(), fetchLatestWaWebVersion: vi.fn() }
})

const directories: string[] = []
const databases: WarishDatabase[] = []
const sockets: WASocket[] = []
const makeSocketMock = vi.mocked(makeWASocket)
const fetchVersionMock = vi.mocked(fetchLatestWaWebVersion)

beforeEach(() => {
  sockets.length = 0
  makeSocketMock.mockImplementation(() => {
    const socket = {
      ev: new EventEmitter(),
      end: vi.fn(),
      groupMetadata: vi.fn()
    } as unknown as WASocket
    sockets.push(socket)
    return socket
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  makeSocketMock.mockReset()
  fetchVersionMock.mockReset()
  while (databases.length) databases.pop()!.close()
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('WhatsAppClient connection compatibility', () => {
  it('uses the live Web revision and refreshes it after a 405 without clearing auth', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const first: WAVersion = [2, 3000, 1044017588]
    const second: WAVersion = [2, 3000, 1044017999]
    fetchVersionMock
      .mockResolvedValueOnce({ version: first, isLatest: true })
      .mockResolvedValueOnce({ version: second, isLatest: true })
    const { client, database } = createLinkedClient()
    const storedAuth = database.getAuth('creds', 'primary')

    await client.connect()

    expect(makeSocketMock.mock.calls[0]?.[0].version).toEqual(first)
    sockets[0]!.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 405 } } as unknown as Error, date: new Date() }
    })
    expect(client.state).toMatchObject({
      phase: 'offline',
      accountState: 'linked',
      message: 'WhatsApp compatibility changed. Refreshing and trying again...'
    })
    expect(database.getAuth('creds', 'primary')?.equals(storedAuth!)).toBe(true)

    await vi.advanceTimersByTimeAsync(1_000)

    expect(fetchVersionMock).toHaveBeenCalledTimes(2)
    expect(makeSocketMock).toHaveBeenCalledTimes(2)
    expect(makeSocketMock.mock.calls[1]?.[0].version).toEqual(second)
  })
})

function createLinkedClient(): { client: WhatsAppClient; database: WarishDatabase } {
  const directory = mkdtempSync(join(tmpdir(), 'warish-connection-'))
  directories.push(directory)
  const logger = pino({ enabled: false })
  const database = new WarishDatabase(join(directory, 'warish.sqlite'), Buffer.alloc(32, 5), logger)
  databases.push(database)
  const auth = createPersistentAuthState(database)
  auth.state.creds.registered = true
  auth.saveCreds()
  database.setAccount('15550001111', 'Connection test')
  const emit = vi.fn()
  const crm = new CrmRepository(database, emit)
  return {
    client: new WhatsAppClient(database, logger, {} as MediaManager, crm, emit),
    database
  }
}
