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
    database.saveDraft({ chatId, text: 'Proposal attached', updatedAt: Date.now(), attachments: [{
      token: 'draft-token.pdf', name: 'Customer proposal.pdf', size: 8, mimeType: 'application/pdf',
      previewUrl: 'warish-media://drafts/draft-token.pdf', kind: 'document'
    }] })
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

  it('sends a native album parent first, then ordered children with one caption and shared association', async () => {
    const media = {
      resolveDraft: vi.fn((token: string) => `C:\\WArish\\drafts\\${token}`),
      discardDraft: vi.fn()
    } as unknown as MediaManager
    const { client, database, events } = createLinkedClient(media)
    await connectClient(client)
    const chatId = '15550004444@s.whatsapp.net'
    database.upsertChat({ id: chatId, title: 'Album customer', kind: 'direct' })
    database.storeMessage({ id: 'quoted-album-message', chatId, fromMe: false, kind: 'text', text: 'Original request',
      timestamp: 1_000, status: 'read', incrementUnread: false, rawPayload: Buffer.from(JSON.stringify({
        key: { id: 'quoted-album-message', remoteJid: chatId, fromMe: false }, messageTimestamp: 1,
        message: { conversation: 'Original request' }
      })) })
    database.saveDraft({ chatId, text: 'Album caption', attachments: albumDraftAttachments(), updatedAt: Date.now() })
    let childIndex = 0
    const persistedBeforeFirstChild: Array<{ messages: number; outbox: number }> = []
    vi.mocked(sockets[0]!.sendMessage).mockImplementation((_jid, content) => {
      const payload = content as Record<string, unknown>
      if (payload.album) return Promise.resolve({
        key: { id: 'remote-album-parent', remoteJid: chatId, fromMe: true },
        messageTimestamp: 2, status: 2, message: { albumMessage: { expectedImageCount: 3 } }
      } as WAMessage)
      if (childIndex === 0) {
        const messages = database.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE id LIKE 'local:album-child-%'").get() as { count: number }
        const outbox = database.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE client_id LIKE 'album-child-%'").get() as { count: number }
        persistedBeforeFirstChild.push({ messages: messages.count, outbox: outbox.count })
      }
      const index = childIndex++
      return Promise.resolve(albumChildMessage(chatId, `remote-album-child-${index}`,
        typeof payload.caption === 'string' ? payload.caption : undefined))
    })

    const result = await client.sendAlbum({
      chatId,
      albumClientId: 'album-client-parent',
      images: [0, 1, 2].map((index) => ({ clientId: `album-child-${index}`, attachmentToken: `album-${index}.png` })),
      caption: 'Album caption',
      quotedMessageId: 'quoted-album-message'
    })

    const calls = vi.mocked(sockets[0]!.sendMessage).mock.calls
    expect(calls).toHaveLength(4)
    expect(calls[0]?.[0]).toBe(chatId)
    expect(calls[0]?.[1]).toEqual({ album: { expectedImageCount: 3 } })
    const parentOptions = calls[0]?.[2] as { messageId?: string; quoted?: WAMessage } | undefined
    expect(parentOptions?.messageId).toBe('ALBUMCLIENTPARENT')
    expect(parentOptions?.quoted?.key.id).toBe('quoted-album-message')
    const childContents = calls.slice(1).map((call) => call[1] as Record<string, unknown>)
    expect(childContents.map((content) => content.caption)).toEqual(['Album caption', undefined, undefined])
    for (const content of childContents) {
      expect(content.albumParentKey).toEqual({ id: 'remote-album-parent', remoteJid: chatId, fromMe: true })
    }
    expect(persistedBeforeFirstChild).toEqual([{ messages: 3, outbox: 3 }])
    expect(result.map((message) => [message.id, message.status])).toEqual([
      ['remote-album-child-0', 'sent'], ['remote-album-child-1', 'sent'], ['remote-album-child-2', 'sent']
    ])
    expect(result[0]).toMatchObject({ quotedMessageId: 'quoted-album-message',
      quoted: { id: 'quoted-album-message', text: 'Original request' } })
    expect(database.listMessages(chatId).items.filter((message) => message.kind === 'image').map((message) => message.id))
      .toEqual(['remote-album-child-0', 'remote-album-child-1', 'remote-album-child-2'])
    expect(database.getDraft(chatId)).toBeUndefined()
    expect(media.discardDraft).toHaveBeenCalledTimes(3)
    const batchEvent = events.find((event) => event.type === 'message.batch')
    expect(batchEvent?.payload.messages.map((message) => message.id)).toContain('local:album-child-0')
    await waitForContactRefresh(client)
  })

  it('continues after child failures and retries the failed image against the same album parent', async () => {
    const media = {
      resolveDraft: vi.fn((token: string) => `C:\\WArish\\drafts\\${token}`),
      discardDraft: vi.fn()
    } as unknown as MediaManager
    const { client, database } = createLinkedClient(media)
    await connectClient(client)
    const chatId = '15550005555@s.whatsapp.net'
    database.upsertChat({ id: chatId, title: 'Partial album', kind: 'direct' })
    database.saveDraft({ chatId, text: 'Partial caption', attachments: albumDraftAttachments(), updatedAt: Date.now() })
    let mediaCall = 0
    vi.mocked(sockets[0]!.sendMessage).mockImplementation((_jid, content) => {
      const payload = content as Record<string, unknown>
      if (payload.album) return Promise.resolve({
        key: { id: 'partial-parent', remoteJid: chatId, fromMe: true }, messageTimestamp: 2, status: 2,
        message: { albumMessage: { expectedImageCount: 3 } }
      } as WAMessage)
      const index = mediaCall++
      if (index === 1) return Promise.reject(new Error('Second image upload failed'))
      return Promise.resolve(albumChildMessage(chatId, `partial-child-${index}`,
        typeof payload.caption === 'string' ? payload.caption : undefined))
    })

    const result = await client.sendAlbum({
      chatId,
      albumClientId: 'partial-parent-client',
      images: [0, 1, 2].map((index) => ({ clientId: `partial-client-${index}`, attachmentToken: `album-${index}.png` })),
      caption: 'Partial caption'
    })

    expect(result.map((message) => message.status)).toEqual(['sent', 'failed', 'sent'])
    expect(media.discardDraft).toHaveBeenCalledWith('album-0.png')
    expect(media.discardDraft).not.toHaveBeenCalledWith('album-1.png')
    expect(media.discardDraft).toHaveBeenCalledWith('album-2.png')
    const queued = database.getOutboxForMessage('local:partial-client-1')
    expect(queued?.payload).toMatchObject({
      attachmentToken: 'album-1.png', albumPosition: 1,
      albumParentKey: { id: 'partial-parent', remoteJid: chatId, fromMe: true }
    })

    vi.mocked(sockets[0]!.sendMessage).mockResolvedValueOnce(albumChildMessage(chatId, 'retried-partial-child'))
    const retried = await client.retry('local:partial-client-1')

    expect(retried).toMatchObject({ id: 'retried-partial-child', status: 'sent' })
    expect(vi.mocked(sockets[0]!.sendMessage).mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      albumParentKey: { id: 'partial-parent', remoteJid: chatId, fromMe: true }
    }))
    expect(media.discardDraft).toHaveBeenCalledWith('album-1.png')
    await waitForContactRefresh(client)
  })

  it('retains the complete composer draft when the album parent fails', async () => {
    const media = { resolveDraft: vi.fn(), discardDraft: vi.fn() } as unknown as MediaManager
    const { client, database } = createLinkedClient(media)
    await connectClient(client)
    const chatId = '15550006666@s.whatsapp.net'
    database.upsertChat({ id: chatId, title: 'Parent failure', kind: 'direct' })
    const attachments = albumDraftAttachments()
    database.saveDraft({ chatId, text: 'Keep this caption', attachments, updatedAt: Date.now() })
    vi.mocked(sockets[0]!.sendMessage).mockRejectedValueOnce(new Error('Album parent rejected'))

    await expect(client.sendAlbum({
      chatId,
      albumClientId: 'failed-parent-client',
      images: attachments.map((attachment, index) => ({ clientId: `failed-child-${index}`, attachmentToken: attachment.token })),
      caption: 'Keep this caption'
    })).rejects.toThrow('Album parent rejected')

    expect(database.getDraft(chatId)?.attachments.map((attachment) => attachment.token))
      .toEqual(['album-0.png', 'album-1.png', 'album-2.png'])
    expect(database.db.prepare('SELECT COUNT(*) AS count FROM outbox').get()).toMatchObject({ count: 0 })
    expect(database.listMessages(chatId).items).toEqual([])
    expect(media.discardDraft).not.toHaveBeenCalled()
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

function albumDraftAttachments(): Array<{
  token: string
  kind: 'image'
  name: string
  size: number
  mimeType: string
  previewUrl: string
}> {
  return [0, 1, 2].map((index) => ({
    token: `album-${index}.png`,
    kind: 'image',
    name: `Album ${index + 1}.png`,
    size: index + 1,
    mimeType: 'image/png',
    previewUrl: `warish-media://drafts/album-${index}.png`
  }))
}

function albumChildMessage(chatId: string, id: string, caption?: string): WAMessage {
  return {
    key: { id, remoteJid: chatId, fromMe: true },
    messageTimestamp: Math.floor(Date.now() / 1_000),
    status: 2,
    message: { imageMessage: { caption, mimetype: 'image/png', fileLength: 1 } }
  } as WAMessage
}
