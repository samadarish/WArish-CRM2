import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import makeWASocket, {
  fetchLatestWaWebVersion,
  type WAVersion,
  type WAMessage,
  type WASocket
} from '@whiskeysockets/baileys'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistentAuthState } from '../src/core/auth-store'
import { CrmRepository } from '../src/core/crm-repository'
import { WarishDatabase } from '../src/core/database'
import type { MediaManager } from '../src/core/media-manager'
import { WhatsAppClient } from '../src/core/whatsapp-client'
import type { CoreEventEnvelope } from '../src/shared/contracts'

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
  fetchVersionMock.mockResolvedValue({ version: [2, 3000, 1044017000], isLatest: true })
  makeSocketMock.mockImplementation(() => {
    const socket = {
      ev: new EventEmitter(),
      end: vi.fn(),
      groupMetadata: vi.fn(),
      groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      communityFetchAllParticipating: vi.fn().mockResolvedValue({}),
      sendMessage: vi.fn()
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
    expect(makeSocketMock.mock.calls[0]?.[0]?.logger?.level).toBe('warn')
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

  it('keeps a successful attachment send successful when draft-file cleanup fails', async () => {
    const media = {
      resolveDraft: vi.fn(() => 'C:\\WArish\\drafts\\draft-token.pdf'),
      discardDraft: vi.fn(() => { throw new Error('File is temporarily locked') })
    } as unknown as MediaManager
    const { client, database, events } = createLinkedClient(media)
    await connectClient(client)
    const chatId = '15550002222@s.whatsapp.net'
    database.upsertChat({ id: chatId, title: 'Customer', kind: 'direct' })
    database.saveDraft({ chatId, text: 'Proposal attached', attachmentKind: 'document', updatedAt: Date.now(), attachment: {
      token: 'draft-token.pdf', name: 'Customer proposal.pdf', size: 8, mimeType: 'application/pdf',
      previewUrl: 'warish-media://drafts/draft-token.pdf'
    } })
    const sentMessage = {
      key: { id: 'remote-proposal', remoteJid: chatId, fromMe: true },
      messageTimestamp: Math.floor(Date.now() / 1_000), status: 2,
      message: { documentMessage: { fileName: 'proposal.pdf', mimetype: 'application/pdf', fileLength: 8,
        caption: 'Proposal attached' } }
    } as WAMessage
    vi.mocked(sockets[0]!.sendMessage).mockResolvedValue(sentMessage)

    const sent = await client.send({ chatId, clientId: 'client-proposal', text: 'Proposal attached',
      attachmentToken: 'draft-token.pdf', attachmentKind: 'document' })

    expect(sent).toMatchObject({ id: 'remote-proposal', status: 'sent' })
    expect(sockets[0]!.sendMessage).toHaveBeenCalledWith(chatId, expect.objectContaining({
      fileName: 'Customer proposal.pdf', mimetype: 'application/pdf'
    }), expect.any(Object))
    expect(media.discardDraft).toHaveBeenCalledWith('draft-token.pdf')
    expect(() => database.getMessage('local:client-proposal')).toThrow()
    expect(database.getMessage('remote-proposal')).toMatchObject({ status: 'sent', clientId: 'client-proposal' })
    expect(database.db.prepare('SELECT COUNT(*) AS count FROM outbox').get()).toMatchObject({ count: 0 })
    expect(events.some((event) => event.type === 'message.changed'
      && event.payload.replacedId === 'local:client-proposal')).toBe(true)
    await waitForContactRefresh(client)
  })

  it('emits the stored monotonic status for late delivery receipts', async () => {
    const { client, database, events } = createLinkedClient()
    await connectClient(client)
    const chatId = '15550003333@s.whatsapp.net'
    database.storeMessage({ id: 'already-read', chatId, fromMe: true, kind: 'text', text: 'Acknowledged',
      timestamp: Date.now(), status: 'read', incrementUnread: false })

    sockets[0]!.ev.emit('messages.update', [{ key: { id: 'already-read', remoteJid: chatId, fromMe: true },
      update: { status: 3 } }])

    expect(database.getMessage('already-read').status).toBe('read')
    expect(events).toContainEqual(expect.objectContaining({ type: 'message.statusChanged',
      payload: { chatId, messageId: 'already-read', status: 'read' } }))
    await waitForContactRefresh(client)
  })
})

async function connectClient(client: WhatsAppClient): Promise<void> {
  await client.connect()
  sockets[0]!.ev.emit('connection.update', { connection: 'open' })
  await vi.waitFor(() => expect(client.state.phase).toBe('connected'))
}

async function waitForContactRefresh(client: WhatsAppClient): Promise<void> {
  await vi.waitFor(() => expect(client.contactSyncState.state).toBe('complete'))
}

function createLinkedClient(media = {} as MediaManager): {
  client: WhatsAppClient
  database: WarishDatabase
  events: CoreEventEnvelope[]
} {
  const directory = mkdtempSync(join(tmpdir(), 'warish-connection-'))
  directories.push(directory)
  const logger = pino({ enabled: false })
  const database = new WarishDatabase(join(directory, 'warish.sqlite'), Buffer.alloc(32, 5), logger)
  databases.push(database)
  const auth = createPersistentAuthState(database)
  auth.state.creds.registered = true
  auth.saveCreds()
  database.setAccount('15550001111', 'Connection test')
  const events: CoreEventEnvelope[] = []
  const emit = (event: CoreEventEnvelope): void => { events.push(event) }
  const crm = new CrmRepository(database, emit)
  return {
    client: new WhatsAppClient(database, logger, media, crm, emit),
    database,
    events
  }
}
