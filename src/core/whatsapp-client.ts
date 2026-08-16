import { basename, extname } from 'node:path'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  delay,
  initAuthCreds,
  proto,
  type Contact,
  type GroupMetadata,
  type WAMessage,
  type WAMessageKey,
  type WASocket
} from '@whiskeysockets/baileys'
import type { Logger } from 'pino'
import QRCode from 'qrcode'
import {
  MAX_ALBUM_IMAGES,
  type AttachmentKind,
  type ContactDetails,
  type ContactSyncState,
  type CoreEventEnvelope,
  type HistoryBatchEvent,
  type MessageDto,
  type OlderHistoryResult,
  type QuotedMessageDto,
  type SessionState
} from '../shared/contracts'
import { mimeTypeForPath } from '../shared/media-types'
import { createPersistentAuthState, hasLinkedAuth, mergeAuthCreds, type PersistentAuthState } from './auth-store'
import { CrmRepository } from './crm-repository'
import { WarishDatabase } from './database'
import { MediaManager } from './media-manager'
import { deserializeRawMessage, isVisibleChatJid, normalizeWhatsAppMessage } from './normalizer'
import { WhatsAppWebVersionResolver } from './whatsapp-version'

type EmitEvent = (event: CoreEventEnvelope) => void
const CLIENT_VERSION_REJECTED_STATUS = 405

interface PendingHistoryRequest {
  chatId: string
  anchor: { id: string; timestamp: number }
  resolve(result: OlderHistoryResult): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

interface OutgoingMessageInput {
  chatId: string
  clientId: string
  text?: string
  attachmentToken?: string
  attachmentKind?: AttachmentKind
  attachmentName?: string
  attachmentMimeType?: string
  quotedMessageId?: string
  albumParentKey?: WAMessageKey
  albumPosition?: number
  albumTimestamp?: number
  displayQuotedMessageId?: string
}

interface OutgoingAlbumInput {
  chatId: string
  albumClientId: string
  images: Array<{ clientId: string; attachmentToken: string }>
  caption?: string
  quotedMessageId?: string
}

export class WhatsAppClient {
  readonly #database: WarishDatabase
  readonly #crm: CrmRepository
  readonly #logger: Logger
  readonly #emit: EmitEvent
  readonly #auth: PersistentAuthState
  readonly #webVersion: WhatsAppWebVersionResolver
  readonly media: MediaManager
  #socket?: WASocket
  #connectPromise?: Promise<SessionState>
  #state: SessionState
  #reconnectAttempt = 0
  #reconnectTimer?: NodeJS.Timeout
  #socketGeneration = 0
  #manualLogout = false
  #initialHistoryCutoff = 0
  readonly #historyBoundaryTypes = new Set<number>()
  readonly #historyRequests = new Map<string, PendingHistoryRequest>()
  readonly #channelMetadataRequests = new Map<string, Promise<void>>()
  #contactSyncState: ContactSyncState = {
    state: 'idle', processed: 0, total: 0, resolvedNames: 0, resolvedPhones: 0, savedNames: 0, profileNames: 0
  }
  #contactSyncPromise?: Promise<ContactSyncState>
  readonly #avatarRequests = new Map<string, Promise<void>>()
  readonly #avatarQueue: Array<() => void> = []
  #activeAvatarRequests = 0
  #silentCrmChanges = false

  constructor(database: WarishDatabase, logger: Logger, media: MediaManager, crm: CrmRepository, emit: EmitEvent) {
    this.#database = database
    this.#crm = crm
    this.#logger = logger
    this.media = media
    this.#emit = emit
    this.#auth = createPersistentAuthState(database)
    this.#webVersion = new WhatsAppWebVersionResolver(logger)
    const hasStoredSession = hasLinkedAuth(this.#auth.state.creds)
    this.#state = {
      phase: hasStoredSession ? 'starting' : 'unlinked',
      accountState: hasStoredSession ? 'linked' : database.hasLinkedAccount() ? 'relink-required' : 'never-linked',
      historySync: { state: 'idle', progress: 0 }
    }
    this.#logger.info({ accountState: this.#state.accountState, credentialsRegistered: this.#auth.state.creds.registered },
      'restored persistent account state')
  }

  get state(): SessionState {
    return { ...this.#state, historySync: this.#state.historySync ? { ...this.#state.historySync } : undefined }
  }
  get socket(): WASocket | undefined { return this.#socket }
  get contactSyncState(): ContactSyncState { return { ...this.#contactSyncState } }

  async initialize(): Promise<void> {
    const interrupted = this.#database.markInterruptedSendsFailed()
    if (interrupted) this.#logger.warn({ interrupted }, 'interrupted outgoing messages marked for explicit retry')
    if (hasLinkedAuth(this.#auth.state.creds)) await this.connect()
    else await Promise.resolve()
    this.#repairStoredMessageContent()
  }

  async connect(): Promise<SessionState> {
    if (this.#socket && ['connecting', 'pairing', 'connected'].includes(this.#state.phase)) return this.state
    if (this.#connectPromise) return this.#connectPromise
    const operation = this.#openSocket()
    this.#connectPromise = operation
    try { return await operation }
    finally { if (this.#connectPromise === operation) this.#connectPromise = undefined }
  }

  async #openSocket(): Promise<SessionState> {
    clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = undefined
    this.#manualLogout = false
    const historyDays = this.#database.getSettings().historySyncDays
    this.#initialHistoryCutoff = Date.now() - historyDays * 24 * 60 * 60 * 1000
    this.#historyBoundaryTypes.clear()
    this.#setState({ phase: hasLinkedAuth(this.#auth.state.creds) ? 'connecting' : 'pairing', message: undefined,
      historySync: { state: 'idle', progress: 0 } })
    const previousSocket = this.#socket
    this.#socket = undefined
    const generation = ++this.#socketGeneration
    void previousSocket?.end(undefined)
    const version = await this.#webVersion.resolve()
    if (this.#manualLogout || this.#socketGeneration !== generation) return this.state
    const requestFullHistory = historyDays > 7
    const socket = makeWASocket({
      version,
      auth: this.#auth.state,
      logger: this.#logger.child({ component: 'baileys' }, { level: 'warn' }),
      browser: Browsers.windows(requestFullHistory ? 'Desktop' : 'Chrome'),
      syncFullHistory: requestFullHistory,
      shouldSyncHistoryMessage: (notification) => this.#shouldDownloadHistory(notification),
      emitOwnEvents: true,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: true,
      getMessage: async (key) => {
        if (!key.id) return undefined
        const raw = this.#database.getRawMessage(key.id)
        return raw ? (deserializeRawMessage(raw).message ?? undefined) : undefined
      },
      cachedGroupMetadata: async (jid) => socket.groupMetadata(jid)
    })
    this.#socket = socket
    this.#bindEvents(socket, generation)
    return this.state
  }

  async requestPairingCode(phoneNumber: string): Promise<SessionState> {
    if (hasLinkedAuth(this.#auth.state.creds)) throw new Error('This account is already linked')
    const normalized = phoneNumber.replace(/\D/g, '')
    if (normalized.length < 7 || normalized.length > 15) throw new Error('Enter a valid international phone number')
    if (!this.#socket) await this.connect()
    const socket = this.#socket
    if (!socket) throw new Error('WhatsApp pairing could not be prepared. Try again.')
    const pairingCode = await socket.requestPairingCode(normalized)
    this.#setState({ phase: 'pairing', pairingCode, qrDataUrl: undefined })
    return this.state
  }

  async prepareRelink(): Promise<SessionState> {
    this.#manualLogout = true
    this.#connectPromise = undefined
    clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = undefined
    const previousSocket = this.#socket
    this.#socket = undefined
    this.#socketGeneration += 1
    void previousSocket?.end(undefined)
    this.#rejectHistoryRequests(new Error('The account is being relinked'))
    this.#database.clearAuth()
    this.#auth.state.creds = initAuthCreds()
    this.#logger.warn('local authentication was cleared after an explicit relink request')
    this.#setState({ phase: 'logged-out', accountState: 'relink-required', message: 'Relink WhatsApp to resume messaging.',
      qrDataUrl: undefined, pairingCode: undefined, historySync: { state: 'idle', progress: 0 } })
    return this.state
  }

  async logout(): Promise<void> {
    this.#manualLogout = true
    this.#connectPromise = undefined
    this.#socketGeneration += 1
    clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = undefined
    try { await this.#socket?.logout() } catch (error) { this.#logger.warn({ error }, 'remote logout failed') }
    this.#socket = undefined
    this.#rejectHistoryRequests(new Error('WhatsApp was unlinked'))
    this.#database.clearAuth()
    this.#auth.state.creds = initAuthCreds()
    this.#setState({ phase: 'logged-out', accountState: this.#database.hasLinkedAccount() ? 'relink-required' : 'never-linked',
      qrDataUrl: undefined, pairingCode: undefined, message: 'WhatsApp was unlinked. Relink to resume messaging.',
      historySync: { state: 'idle', progress: 0 } })
  }

  async send(input: OutgoingMessageInput): Promise<MessageDto> {
    this.#requireSocket()
    if (!input.text?.trim() && !input.attachmentToken) throw new Error('A message cannot be empty')
    const chatId = this.#database.resolveChatId(input.chatId)
    if (this.#database.getChat(chatId).readOnly) throw new Error('This conversation is read only')
    const localId = `local:${input.clientId}`
    const draft = this.#database.getDraft(chatId)
    const draftAttachment = draft?.attachments.find((attachment) => attachment.token === input.attachmentToken)
    const normalizedInput = { ...input, chatId, text: input.text?.trim() || undefined,
      attachmentName: draftAttachment?.name, attachmentMimeType: draftAttachment?.mimeType }
    let local!: MessageDto
    this.#database.transaction(() => {
      this.#database.enqueueOutbox(input.clientId, chatId, normalizedInput)
      this.#database.updateOutbox(input.clientId, 'sending')
      local = this.#database.upsertMessage({
        id: localId,
        chatId,
        fromMe: true,
        kind: input.attachmentKind ?? 'text',
        text: normalizedInput.text,
        timestamp: Date.now(),
        status: 'sending',
        clientId: input.clientId,
        attachment: input.attachmentToken ? {
          id: `attachment:${localId}`,
          kind: input.attachmentKind ?? 'document',
          fileName: draftAttachment?.name,
          mimeType: draftAttachment?.mimeType,
          size: draftAttachment?.size,
          draftToken: input.attachmentToken,
          downloadState: 'ready'
        } : undefined
      })
      const draftText = draft?.text.trim() || undefined
      const draftTokens = draft?.attachments.map((attachment) => attachment.token) ?? []
      const inputTokens = input.attachmentToken ? [input.attachmentToken] : []
      if (draft && draftText === normalizedInput.text && sameOrderedValues(draftTokens, inputTokens)) {
        this.#database.clearDraft(chatId)
      }
    })
    this.#emit({ type: 'message.changed', payload: { message: local } })
    return this.#deliver(normalizedInput, localId)
  }

  async sendAlbum(input: OutgoingAlbumInput): Promise<MessageDto[]> {
    const socket = this.#requireSocket()
    if (input.images.length < 2 || input.images.length > MAX_ALBUM_IMAGES) {
      throw new Error(`Albums require between 2 and ${MAX_ALBUM_IMAGES} images`)
    }
    if (new Set(input.images.map((image) => image.clientId)).size !== input.images.length) {
      throw new Error('Album image client IDs must be unique')
    }
    const chatId = this.#database.resolveChatId(input.chatId)
    if (this.#database.getChat(chatId).readOnly) throw new Error('This conversation is read only')
    const caption = input.caption?.trim() || undefined
    const draft = this.#database.getDraft(chatId)
    const draftByToken = new Map(draft?.attachments.map((attachment) => [attachment.token, attachment]) ?? [])
    for (const image of input.images) {
      const attachment = draftByToken.get(image.attachmentToken)
      if (!attachment || attachment.kind !== 'image') throw new Error('Every album item must be a staged image')
    }

    const quotedRaw = input.quotedMessageId ? this.#database.getRawMessage(input.quotedMessageId) : undefined
    const quoted = quotedRaw ? deserializeRawMessage(quotedRaw) : undefined
    const displayQuoted = input.quotedMessageId ? this.#quotedMessage(input.quotedMessageId) : undefined
    const parent = await socket.sendMessage(chatId, { album: { expectedImageCount: input.images.length } }, {
      ...(quoted ? { quoted } : {}),
      messageId: stableWhatsAppMessageId(input.albumClientId)
    })
    if (!parent?.key.id) throw new Error('WhatsApp did not return the album parent')
    const albumParentKey: WAMessageKey = {
      ...parent.key,
      id: parent.key.id,
      remoteJid: parent.key.remoteJid ?? chatId,
      fromMe: parent.key.fromMe ?? true
    }
    const albumTimestamp = Date.now()
    const deliveries = input.images.map((image, position): OutgoingMessageInput => {
      const attachment = draftByToken.get(image.attachmentToken)!
      return {
        chatId,
        clientId: image.clientId,
        text: position === 0 ? caption : undefined,
        attachmentToken: image.attachmentToken,
        attachmentKind: 'image',
        attachmentName: attachment.name,
        attachmentMimeType: attachment.mimeType,
        albumParentKey,
        albumPosition: position,
        albumTimestamp,
        displayQuotedMessageId: position === 0 ? input.quotedMessageId : undefined
      }
    })
    let localMessages: MessageDto[] = []
    this.#database.transaction(() => {
      localMessages = deliveries.map((delivery) => {
        this.#database.enqueueOutbox(delivery.clientId, chatId, delivery)
        this.#database.updateOutbox(delivery.clientId, 'sending')
        const attachment = draftByToken.get(delivery.attachmentToken!)!
        return this.#database.upsertMessage({
          id: `local:${delivery.clientId}`,
          chatId,
          fromMe: true,
          kind: 'image',
          text: delivery.text,
          timestamp: albumTimestamp + (delivery.albumPosition ?? 0),
          status: 'sending',
          clientId: delivery.clientId,
          quotedMessageId: delivery.displayQuotedMessageId,
          quoted: delivery.displayQuotedMessageId ? displayQuoted : undefined,
          attachment: {
            id: `attachment:local:${delivery.clientId}`,
            kind: 'image',
            fileName: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.size,
            draftToken: attachment.token,
            downloadState: 'ready'
          }
        })
      })
      const draftText = draft?.text.trim() || undefined
      if (draft && draftText === caption && sameOrderedValues(
        draft.attachments.map((attachment) => attachment.token),
        input.images.map((image) => image.attachmentToken)
      )) this.#database.clearDraft(chatId)
    })
    this.#emit({ type: 'message.batch', payload: { messages: localMessages } })

    const results: MessageDto[] = []
    for (const delivery of deliveries) {
      const localId = `local:${delivery.clientId}`
      try { results.push(await this.#deliver(delivery, localId)) }
      catch { results.push(this.#database.getMessage(localId)) }
    }
    return results
  }

  async retry(messageId: string): Promise<MessageDto> {
    this.#requireSocket()
    const queued = this.#database.getOutboxForMessage(messageId)
    if (!queued) throw new Error('This failed message is no longer available to retry')
    const payload = queued.payload as unknown as OutgoingMessageInput
    if (!payload.chatId || !payload.clientId || payload.clientId !== queued.clientId) throw new Error('The failed message payload is invalid')
    this.#database.updateOutbox(queued.clientId, 'sending')
    this.#database.updateMessageStatus(messageId, 'sending')
    const sending = this.#database.getMessage(messageId)
    this.#emit({ type: 'message.changed', payload: { message: sending } })
    return this.#deliver(payload, messageId)
  }

  async #deliver(input: OutgoingMessageInput, localId: string): Promise<MessageDto> {
    const socket = this.#requireSocket()
    try {
      const quotedRaw = input.quotedMessageId ? this.#database.getRawMessage(input.quotedMessageId) : undefined
      const quoted = quotedRaw ? deserializeRawMessage(quotedRaw) : undefined
      const content = input.attachmentToken
        ? mediaContent(this.media.resolveDraft(input.attachmentToken), input.attachmentKind ?? 'document', input.text,
          input.attachmentName, input.attachmentMimeType)
        : { text: input.text!.trim() }
      if (input.albumParentKey) content.albumParentKey = input.albumParentKey
      const options = { ...(quoted ? { quoted } : {}), messageId: stableWhatsAppMessageId(input.clientId) }
      const sent = await socket.sendMessage(input.chatId, content as any, options)
      if (!sent) throw new Error('WhatsApp did not return the sent message')
      const normalized = normalizeWhatsAppMessage(sent)
      if (!normalized.message) throw new Error('Sent message could not be normalized')
      normalized.message.clientId = input.clientId
      if (input.albumTimestamp !== undefined) normalized.message.timestamp = input.albumTimestamp + (input.albumPosition ?? 0)
      if (input.displayQuotedMessageId) {
        normalized.message.quotedMessageId = input.displayQuotedMessageId
        normalized.message.quoted = this.#quotedMessage(input.displayQuotedMessageId)
      }
      let stored!: MessageDto
      this.#database.transaction(() => {
        this.#database.deleteStoredMessage(localId)
        stored = this.#database.upsertMessage(normalized.message!)
        this.#database.deleteOutbox(input.clientId)
      })
      if (input.attachmentToken) {
        try { this.media.discardDraft(input.attachmentToken) }
        catch (error) {
          this.#logger.warn({ error, attachmentToken: input.attachmentToken }, 'sent attachment draft cleanup failed')
        }
      }
      this.#emit({ type: 'message.changed', payload: { message: stored, replacedId: localId } })
      return stored
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Message failed'
      this.#database.updateOutbox(input.clientId, 'failed', message)
      this.#database.updateMessageStatus(localId, 'failed', message)
      const failed = this.#database.getMessage(localId)
      this.#emit({ type: 'message.changed', payload: { message: failed } })
      throw error
    }
  }

  #quotedMessage(messageId: string): QuotedMessageDto | undefined {
    try {
      const message = this.#database.getMessage(messageId)
      return { id: message.id, senderName: message.senderName, fromMe: message.fromMe, kind: message.kind,
        text: message.deleted ? 'This message was deleted' : message.text }
    } catch {
      return undefined
    }
  }

  async react(chatId: string, messageId: string, emoji?: string): Promise<void> {
    if (this.#database.getChat(chatId).readOnly) throw new Error('This conversation is read only')
    const key = this.#messageKey(messageId)
    await this.#requireSocket().sendMessage(this.#database.resolveChatId(chatId), { react: { key, text: emoji ?? '' } })
    this.#database.upsertReaction(messageId, 'me', emoji)
    this.#emit({ type: 'message.changed', payload: { message: this.#database.getMessage(messageId) } })
  }

  async edit(chatId: string, messageId: string, text: string): Promise<void> {
    if (this.#database.getChat(chatId).readOnly) throw new Error('This conversation is read only')
    const key = this.#messageKey(messageId)
    await this.#requireSocket().sendMessage(this.#database.resolveChatId(chatId), { text, edit: key })
    this.#database.markMessageEdited(messageId, text)
    this.#emit({ type: 'message.changed', payload: { message: this.#database.getMessage(messageId) } })
  }

  async delete(chatId: string, messageId: string, mode: 'for-me' | 'for-everyone'): Promise<void> {
    if (this.#database.getChat(chatId).kind === 'channel') throw new Error('Channel posts cannot be deleted here')
    if (mode === 'for-everyone') {
      await this.#requireSocket().sendMessage(this.#database.resolveChatId(chatId), { delete: this.#messageKey(messageId) })
    }
    this.#database.markMessageDeleted(messageId)
    this.#emit({ type: 'message.changed', payload: { message: this.#database.getMessage(messageId) } })
  }

  async forward(messageId: string, chatIds: string[]): Promise<void> {
    const raw = this.#database.getRawMessage(messageId)
    if (!raw) throw new Error('The original message is unavailable')
    const message = deserializeRawMessage(raw)
    for (const chatId of chatIds) {
      const resolvedChatId = this.#database.resolveChatId(chatId)
      if (this.#database.getChat(resolvedChatId).readOnly) throw new Error('Messages cannot be forwarded into a read-only conversation')
      await this.#requireSocket().sendMessage(resolvedChatId, { forward: message })
    }
  }

  async markRead(chatId: string): Promise<void> {
    chatId = this.#database.resolveChatId(chatId)
    const messageId = this.#database.latestIncomingMessageId(chatId)
    this.#database.markChatRead(chatId)
    this.#emit({ type: 'chat.changed', payload: { chatId } })
    const chat = this.#database.getChat(chatId)
    if (chat.kind !== 'channel' && messageId && this.#socket) void this.#socket.readMessages([{ id: messageId, remoteJid: chatId, fromMe: false }])
      .catch((error) => this.#logger.warn({ error, chatId }, 'remote read receipt failed after local chat was marked read'))
  }

  async getChat(chatId: string) {
    chatId = this.#database.resolveChatId(chatId)
    let chat = this.#database.getChat(chatId)
    if (!this.#socket) return chat
    if (chat.kind === 'channel' && (chat.title === 'Channel' || !chat.avatarUrl)) {
      await this.#hydrateChannelMetadata(chatId, this.#socket)
      return this.#database.getChat(chatId)
    }
    if (!chatId.endsWith('@g.us') || (chat.title !== 'Group' && chat.title !== 'Community')) return chat
    try {
      const metadata = await this.#socket.groupMetadata(chatId)
      if (metadata.subject?.trim()) {
        this.#ingestGroupMetadata(metadata, false)
        this.#emit({ type: 'chat.changed', payload: { chatId } })
        chat = this.#database.getChat(chatId)
      }
    } catch (error) {
      this.#logger.warn({ error }, 'group name lookup failed')
    }
    return chat
  }

  async getContact(chatId: string): Promise<ContactDetails> {
    const resolved = this.#database.resolveChatId(chatId)
    if (this.#socket) await this.hydrateContacts([resolved])
    return this.#database.getContactDetails(resolved)
  }

  async saveContact(chatId: string, fullNameInput: string): Promise<ContactDetails> {
    const fullName = fullNameInput.trim().replace(/\s+/g, ' ').slice(0, 160)
    if (!fullName) throw new Error('Contact name cannot be empty')
    const address = this.#database.contactAddressing(chatId)
    const chat = this.#database.getChat(address.chatId)
    if (chat.kind !== 'direct') throw new Error('Only direct WhatsApp contacts can be saved')
    const targetJid = address.phoneJid ?? address.lidJid ?? address.chatId
    if (!targetJid.endsWith('@s.whatsapp.net') && !targetJid.endsWith('@lid') && !targetJid.endsWith('@hosted.lid')) {
      throw new Error('This contact has no usable WhatsApp address')
    }
    await addOrEditWhatsAppContact(this.#requireSocket(), targetJid, fullName, address)
    const phoneNumber = address.phoneJid?.split('@')[0]
    this.#database.upsertContact({
      id: address.phoneJid ?? targetJid,
      lid: address.lidJid,
      phoneNumber,
      name: fullName
    })
    this.#emit({ type: 'contact.changed', payload: { chatIds: [address.chatId] } })
    this.#emit({ type: 'chat.changed', payload: { chatId: address.chatId } })
    return this.#database.getContactDetails(address.chatId)
  }

  async hydrateContacts(chatIds: string[]): Promise<void> {
    const socket = this.#socket
    if (!socket) return
    const unique = [...new Set(chatIds.map((chatId) => this.#database.resolveChatId(chatId)))].slice(0, 100)
    if (!unique.length) return
    await this.#reconcileContactMappings(unique, socket, this.#socketGeneration)
    if (this.#state.phase !== 'connected') return
    await Promise.allSettled(unique.map((chatId) => this.#hydrateContactAvatar(chatId, socket)))
  }

  async refreshContacts(): Promise<ContactSyncState> {
    const socket = this.#requireSocket()
    return this.#refreshContactIdentities(socket, this.#socketGeneration, true)
  }

  async loadEarlier(chatId: string): Promise<OlderHistoryResult> {
    chatId = this.#database.resolveChatId(chatId)
    if (this.#database.getChat(chatId).kind === 'channel') throw new Error('Earlier channel history is not available')
    const socket = this.#requireSocket()
    if ([...this.#historyRequests.values()].some((request) => request.chatId === chatId)) {
      throw new Error('An earlier-history request is already running for this chat')
    }
    const anchor = this.#database.getOldestMessageAnchor(chatId)
    if (!anchor) throw new Error('No local message is available to anchor an earlier-history request')
    const message = deserializeRawMessage(anchor.rawPayload)
    if (!message.key.id || !message.key.remoteJid) throw new Error('The oldest local message has no usable WhatsApp key')
    const requestId = await socket.fetchMessageHistory(
      50,
      message.key,
      message.messageTimestamp ?? Math.floor(anchor.timestamp / 1000)
    )
    return new Promise<OlderHistoryResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#historyRequests.delete(requestId)
        reject(new Error('WhatsApp did not return earlier messages in time'))
      }, 25_000)
      this.#historyRequests.set(requestId, { chatId, anchor: { id: anchor.id, timestamp: anchor.timestamp }, resolve, reject, timer })
    })
  }

  #runSocketEvent(name: string, operation: () => void | Promise<void>, onError?: (error: unknown) => void): void {
    const report = (error: unknown): void => {
      this.#logger.error({ error, event: name }, 'WhatsApp event handler failed')
      try { onError?.(error) }
      catch (followUpError) { this.#logger.error({ error: followUpError, event: name }, 'WhatsApp event recovery failed') }
    }
    try {
      const result = operation()
      if (result) void result.catch(report)
    } catch (error) { report(error) }
  }

  #bindEvents(socket: WASocket, generation: number): void {
    const isActive = (): boolean => this.#socket === socket && this.#socketGeneration === generation
    socket.ev.on('creds.update', (update) => this.#runSocketEvent('creds.update', () => {
      if (!isActive()) return
      mergeAuthCreds(this.#auth.state.creds, update)
      this.#auth.saveCreds()
      if (hasLinkedAuth(this.#auth.state.creds) && this.#state.accountState !== 'linked') {
        this.#setState({ accountState: 'linked', message: undefined })
      }
    }))
    socket.ev.on('connection.update', (update) => this.#runSocketEvent('connection.update', async () => {
      if (!isActive()) return
      if (update.qr) {
        if (hasLinkedAuth(this.#auth.state.creds) || this.#state.accountState === 'linked') {
          this.#logger.warn('ignored an unexpected pairing QR because registered credentials are present')
        } else {
          const qrDataUrl = await QRCode.toDataURL(update.qr, { margin: 1, width: 280, errorCorrectionLevel: 'M' })
          if (!isActive()) return
          this.#setState({ phase: 'pairing', qrDataUrl, pairingCode: undefined })
        }
      }
      if (update.connection === 'open') {
        this.#reconnectAttempt = 0
        if (!this.#auth.state.creds.registered) {
          this.#auth.state.creds.registered = true
          this.#auth.saveCreds()
        }
        const user = socket.user
        this.#database.setAccount(user?.id?.split(':')[0], user?.name)
        this.#setState({ phase: 'connected', accountState: 'linked', qrDataUrl: undefined, pairingCode: undefined,
          message: undefined, phoneNumber: user?.id?.split(':')[0] })
        void this.#refreshConversationMetadata(socket, generation)
        void this.#refreshContactIdentities(socket, generation, false)
      }
      if (update.connection === 'close') this.#handleDisconnect(update.lastDisconnect?.error, socket, generation)
    }, () => {
      if (isActive()) this.#setState({ phase: 'error', message: 'WhatsApp connection state could not be processed.' })
    }))

    socket.ev.on('messaging-history.set', (history) => this.#runSocketEvent('messaging-history.set', async () => {
      if (!isActive()) return
      const startedAt = Date.now()
      const isOnDemand = history.syncType === proto.HistorySync.HistorySyncType.ON_DEMAND
      if (!isOnDemand) this.#setHistorySync('running', history.progress ?? undefined)
      const historyDays = this.#database.getSettings().historySyncDays
      const received = history.messages ?? []
      const messages = isOnDemand ? received : filterInitialHistoryMessages(received, this.#initialHistoryCutoff)
      const mergedChats: Array<{ chatId: string; mergedChatIds: string[] }> = []
      this.#database.transaction(() => {
        for (const mapping of history.lidPnMappings ?? []) {
          const merge = this.#database.linkContactLid(mapping.lid, mapping.pn)
          if (merge) mergedChats.push(merge)
        }
        for (const contact of history.contacts ?? []) this.#ingestContact(contact)
      })
      const chatIds = new Set(messages.map((message) => message.key.remoteJid).filter(isVisibleChatJid)
        .map((chatId) => this.#database.resolveChatId(chatId)))
      this.#database.transaction(() => {
        for (const chat of history.chats ?? []) {
          const id = chat.id ?? undefined
          const structuralMetadata = Boolean(id?.endsWith('@newsletter') || id?.endsWith('@g.us') || chat.isParentGroup || chat.parentGroupId)
          if (isOnDemand || structuralMetadata || (id && chatIds.has(this.#database.resolveChatId(id)))) this.#ingestChat(chat as any, false)
        }
      })
      for (const merge of mergedChats) this.#emit({ type: 'chat.merged', payload: merge })
      if ((history.contacts?.length ?? 0) || (history.lidPnMappings?.length ?? 0)) {
        this.#emit({ type: 'contact.changed', payload: { chatIds: [], bulk: true } })
      }
      const affectedChatIds = new Set<string>()
      this.#silentCrmChanges = false
      for (let index = 0; index < messages.length; index += 500) {
        this.#database.transaction(() => {
          for (const message of messages.slice(index, index + 500)) {
            const chatId = this.#ingestMessage(message, false, false)
            if (chatId) affectedChatIds.add(chatId)
          }
        })
        this.#emit({ type: 'sync.progress', payload: {
          processed: Math.min(index + 500, messages.length), total: messages.length,
          skipped: received.length - messages.length, historyDays
        } })
        await delay(0)
        if (!isActive()) return
      }
      const batch: HistoryBatchEvent = {
        chatIds: [...affectedChatIds], messageCount: messages.length, onDemand: isOnDemand
      }
      this.#emit({ type: 'history.batch', payload: batch })
      if (this.#silentCrmChanges) this.#emit({ type: 'crm.changed', payload: { scope: 'all' } })
      this.#logger.info({ syncType: history.syncType, contacts: history.contacts?.length ?? 0,
        mappings: history.lidPnMappings?.length ?? 0, received: received.length, stored: messages.length,
        skipped: received.length - messages.length, historyDays, isOnDemand,
        durationMs: Date.now() - startedAt }, 'history sync chunk stored')
      if (isOnDemand) this.#resolveHistoryRequest(history.peerDataRequestSessionId, messages)
      else if (history.syncType === proto.HistorySync.HistorySyncType.RECENT && Number(history.progress) >= 100) {
        this.#setHistorySync('complete', 100)
      }
    }, (error) => {
      if (!isActive()) return
      if (history.syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
        this.#rejectHistoryRequest(history.peerDataRequestSessionId, error instanceof Error ? error : new Error(String(error)))
      } else this.#setHistorySync('paused')
    }))

    socket.ev.on('messaging-history.status', ({ syncType, status }) => this.#runSocketEvent('messaging-history.status', () => {
      if (!isActive()) return
      if (syncType !== proto.HistorySync.HistorySyncType.RECENT) return
      if (status === 'complete') this.#setHistorySync('complete', 100)
      else this.#setHistorySync('paused')
    }))

    socket.ev.on('contacts.upsert', (contacts) => this.#runSocketEvent('contacts.upsert', () => {
      if (isActive()) this.#ingestContacts(contacts)
    }))
    socket.ev.on('contacts.update', (contacts) => this.#runSocketEvent('contacts.update', () => {
      if (isActive()) this.#ingestContacts(contacts)
    }))
    socket.ev.on('lid-mapping.update', ({ lid, pn }) => this.#runSocketEvent('lid-mapping.update', () => {
      if (!isActive()) return
      const merge = this.#database.linkContactLid(lid, pn)
      if (merge) this.#emit({ type: 'chat.merged', payload: merge })
      this.#emit({ type: 'contact.changed', payload: { chatIds: [this.#database.resolveChatId(lid)] } })
    }))
    socket.ev.on('chats.upsert', (chats) => this.#runSocketEvent('chats.upsert', () => {
      if (isActive()) chats.forEach((chat) => this.#ingestChat(chat as any))
    }))
    socket.ev.on('chats.update', (chats) => this.#runSocketEvent('chats.update', () => {
      if (isActive()) chats.forEach((chat) => this.#ingestChat(chat as any))
    }))
    socket.ev.on('groups.update', (groups) => this.#runSocketEvent('groups.update', () => {
      groups.forEach((group) => {
        if (isActive()) this.#ingestGroupMetadata(group)
      })
    }))
    socket.ev.on('newsletter-settings.update', ({ id }) => this.#runSocketEvent('newsletter-settings.update', () => {
      if (isActive()) return this.#hydrateChannelMetadata(id, socket)
    }))
    socket.ev.on('messages.upsert', ({ messages }) => this.#runSocketEvent('messages.upsert', () => {
      if (!isActive()) return
      messages.forEach((message) => this.#ingestMessage(message))
    }))
    socket.ev.on('messages.update', (updates) => this.#runSocketEvent('messages.update', () => {
      if (!isActive()) return
      for (const { key, update } of updates) {
        if (!key.id || update.status === undefined) continue
        const receiptStatus = Number(update.status) >= 4 ? 'read' : Number(update.status) === 3 ? 'delivered' : 'sent'
        const status = this.#database.updateMessageStatus(key.id, receiptStatus)
        if (!status) continue
        try {
          const changed = this.#database.getMessage(key.id)
          this.#emit({ type: 'message.statusChanged', payload: { chatId: changed.chatId, messageId: key.id, status } })
        } catch { /* A receipt can arrive before its message is locally available. */ }
      }
    }))
    socket.ev.on('presence.update', (presence) => this.#runSocketEvent('presence.update', () => {
      if (isActive()) this.#emit({ type: 'presence.changed', payload: presence })
    }))
  }

  #repairStoredMessageContent(): void {
    if (!this.#database.needsMessageContentRepair()) return
    const messageIds = this.#database.listMessageIdsForContentRepair()
    const repairs = [] as Array<NonNullable<ReturnType<typeof normalizeWhatsAppMessage>['message']>>
    const removals: string[] = []
    let skipped = 0
    for (const messageId of messageIds) {
      const raw = this.#database.getRawMessage(messageId)
      if (!raw) continue
      try {
        const normalized = normalizeWhatsAppMessage(deserializeRawMessage(raw))
        if (normalized.message) {
          normalized.message.incrementUnread = false
          repairs.push(normalized.message)
        } else {
          removals.push(messageId)
        }
      } catch (error) {
        skipped += 1
        this.#logger.warn({ error, messageId }, 'stored message could not be decoded during content repair')
      }
    }
    this.#database.transaction(() => {
      for (const message of repairs) this.#database.storeMessage(message)
      for (const messageId of removals) this.#database.deleteStoredMessage(messageId)
      this.#database.completeMessageContentRepair()
    })
    this.#logger.info({ candidates: messageIds.length, repaired: repairs.length, removed: removals.length, skipped },
      'stored message content repair completed')
  }

  #ingestContacts(contacts: Array<Partial<Contact>>): void {
    this.#database.transaction(() => contacts.forEach((contact) => this.#ingestContact(contact)))
    const chatIds = contacts.map(contactEventId).filter((id): id is string => Boolean(id))
      .map((id) => this.#database.resolveChatId(id))
    this.#emit({ type: 'contact.changed', payload: { chatIds, bulk: chatIds.length > 50 } })
  }

  #ingestContact(contact: Partial<Contact>): void {
    const input = normalizeContactIdentityInput(contact)
    if (input) this.#database.upsertContact(input)
  }

  #ingestChat(chat: any, emitChange = true): void {
    if (!isVisibleChatJid(chat.id)) return
    const rawId = String(chat.id)
    const mapping = directIdentityMapping(rawId, chat.lidJid, chat.pnJid)
    if (mapping) {
      const merge = this.#database.linkContactLid(mapping.lid, mapping.pn)
      if (emitChange && merge) this.#emit({ type: 'chat.merged', payload: merge })
    }
    const id = this.#database.resolveChatId(rawId)
    const isChannel = rawId.endsWith('@newsletter')
    const isGroup = rawId.endsWith('@g.us')
    const isCommunity = Boolean(chat.isParentGroup)
    const communityId = typeof chat.parentGroupId === 'string' && chat.parentGroupId ? chat.parentGroupId : null
    const classificationKnown = isChannel || !isGroup || chat.isParentGroup !== undefined ||
      chat.parentGroupId !== undefined || chat.isDefaultSubgroup !== undefined
    if (communityId) this.#ensureCommunityParent(communityId)
    const kind = isChannel ? 'channel' : isCommunity ? 'community' : isGroup ? 'group' : 'direct'
    const metadataTitle = typeof chat.name === 'string' && chat.name.trim()
      ? chat.name.trim()
      : typeof chat.displayName === 'string' && chat.displayName.trim() ? chat.displayName.trim() : undefined
    if (kind === 'direct' && metadataTitle) {
      const phoneJid = isPhoneJid(rawId) ? rawId : mapping?.pn
      this.#database.upsertContact({ id, phoneNumber: phoneJid?.split('@')[0], name: metadataTitle })
    }
    this.#database.upsertChat({ id, title: kind === 'direct' ? labelForJid(id) : metadataTitle ?? labelForJid(id), kind,
      communityId, isAnnouncement: Boolean(chat.isDefaultSubgroup), classificationKnown,
      description: typeof chat.description === 'string' ? chat.description : undefined,
      unreadCount: Number(chat.unreadCount ?? 0), archived: Boolean(chat.archived), pinned: Boolean(chat.pinned),
      mutedUntil: chat.conversationTimestamp ? Number(chat.muteEndTime ?? 0) : undefined })
    if (isChannel && emitChange) void this.#hydrateChannelMetadata(id, this.#socket)
    if (emitChange) this.#emit({ type: 'chat.changed', payload: { chatId: id } })
  }

  #ingestGroupMetadata(group: Partial<GroupMetadata> & { id?: string }, emitChange = true): void {
    if (!group.id) return
    const chatId = this.#database.resolveChatId(group.id)
    const communityId = group.linkedParent ?? null
    if (communityId) this.#ensureCommunityParent(communityId)
    const kind = group.isCommunity ? 'community' : 'group'
    this.#database.upsertChat({
      id: chatId,
      title: group.subject?.trim() || labelForJid(chatId),
      kind,
      communityId,
      isAnnouncement: Boolean(group.isCommunityAnnounce),
      description: group.desc?.trim() || undefined,
      classificationKnown: true
    })
    if (emitChange) this.#emit({ type: 'chat.changed', payload: { chatId } })
  }

  #ensureCommunityParent(communityId: string): void {
    this.#database.upsertChat({
      id: communityId,
      title: 'Community',
      kind: 'community',
      preserveTitle: true,
      communityId: null,
      classificationKnown: true
    })
  }

  #ingestMessage(message: WAMessage, incrementUnread = true, emitChange = true): string | undefined {
    for (const mapping of messageIdentityMappings(message)) {
      const merge = this.#database.linkContactLid(mapping.lid, mapping.pn)
      if (emitChange && merge) this.#emit({ type: 'chat.merged', payload: merge })
    }
    const normalized = normalizeWhatsAppMessage(message)
    if (normalized.deletionId) this.#database.markMessageDeleted(normalized.deletionId)
    if (normalized.edit) this.#database.markMessageEdited(normalized.edit.messageId, normalized.edit.text)
    if (normalized.reaction) this.#database.upsertReaction(normalized.reaction.messageId, normalized.reaction.senderId, normalized.reaction.emoji)
    if (!normalized.message) {
      const changedId = normalized.deletionId ?? normalized.edit?.messageId ?? normalized.reaction?.messageId
      if (emitChange && changedId) {
        try { this.#emit({ type: 'message.changed', payload: { message: this.#database.getMessage(changedId) } }) }
        catch { /* The referenced message may be outside the selected local history window. */ }
      }
      return changedId && isVisibleChatJid(message.key.remoteJid)
        ? this.#database.resolveChatId(message.key.remoteJid)
        : undefined
    }
    normalized.message.chatId = this.#database.resolveChatId(normalized.message.chatId)
    normalized.message.incrementUnread = incrementUnread
    if (normalized.message.senderName && normalized.message.senderId) {
      this.#database.upsertContact({ id: normalized.message.senderId, pushName: normalized.message.senderName })
    }
    if (emitChange) {
      const stored = this.#database.upsertMessage(normalized.message)
      this.#emit({ type: 'message.upserted', payload: stored })
    } else {
      this.#database.storeMessage(normalized.message)
    }
    if (!normalized.message.fromMe) {
      const created = this.#crm.ensureInboundLead(normalized.message.chatId, normalized.message.timestamp, emitChange)
      if (created && !emitChange) this.#silentCrmChanges = true
    }
    if (normalized.message.chatId.endsWith('@newsletter') && emitChange) {
      void this.#hydrateChannelMetadata(normalized.message.chatId, this.#socket)
    }
    return normalized.message.chatId
  }

  async #refreshContactIdentities(socket: WASocket, generation: number, manual: boolean): Promise<ContactSyncState> {
    if (this.#contactSyncPromise) return this.#contactSyncPromise
    const operation = (async (): Promise<ContactSyncState> => {
      let hadFailure = false
      await delay(0)
      let lids = this.#database.listDirectLidChatIds()
      this.#setContactSyncState({ state: 'running', processed: 0, total: lids.length,
        ...this.#resolvedContactCounts() })
      if (manual) {
        try {
          this.#auth.resetAppStateSyncVersion('critical_unblock_low')
          await socket.resyncAppState(['critical_unblock_low'], false)
        } catch (error) {
          hadFailure = true
          this.#logger.warn({ reason: error instanceof Error ? error.name : 'unknown' }, 'contact app-state refresh failed')
        }
      }
      try {
        this.#database.rebuildCanonicalContacts()
      } catch (error) {
        hadFailure = true
        this.#logger.warn({ reason: error instanceof Error ? error.name : 'unknown' }, 'canonical contact rebuild failed')
      }
      lids = this.#database.listDirectLidChatIds()
      this.#setContactSyncState({ state: 'running', processed: 0, total: lids.length,
        ...this.#resolvedContactCounts() })
      try {
        let offset = 0
        while (this.#socket === socket && this.#socketGeneration === generation) {
          const storedMappings = this.#database.recoverContactLidMappings(250, offset, lids)
          for (const merge of storedMappings.merges) this.#emit({ type: 'chat.merged', payload: merge })
          if (storedMappings.mappings) this.#emit({ type: 'contact.changed', payload: { chatIds: [], bulk: true } })
          offset += storedMappings.scanned
          if (storedMappings.scanned < 250) break
          await delay(0)
        }
      } catch (error) {
        hadFailure = true
        this.#logger.warn({ reason: error instanceof Error ? error.name : 'unknown' }, 'stored contact mappings refresh failed')
      }
      lids = this.#database.listDirectLidChatIds()
      this.#setContactSyncState({ state: 'running', processed: 0, total: lids.length,
        ...this.#resolvedContactCounts() })
      let processed = 0
      for (let index = 0; index < lids.length; index += 50) {
        if (this.#socket !== socket || this.#socketGeneration !== generation) {
          const state = { state: 'partial' as const, processed, total: lids.length,
            ...this.#resolvedContactCounts(), message: 'Contact refresh paused while WhatsApp is offline.' }
          this.#setContactSyncState(state)
          return state
        }
        const batch = lids.slice(index, index + 50)
        try { await this.#reconcileContactMappings(batch, socket, generation) }
        catch { hadFailure = true }
        processed += batch.length
        this.#setContactSyncState({ state: 'running', processed, total: lids.length,
          ...this.#resolvedContactCounts() })
        await delay(0)
      }
      const coverage = this.#database.identityCoverage()
      const unresolved = Math.max(0, coverage.directChats - coverage.resolvedNames)
      const state: ContactSyncState = {
        state: hadFailure ? 'partial' : 'complete',
        processed,
        total: lids.length,
        ...this.#resolvedContactCounts(),
        ...(unresolved ? { message: `${unresolved} contacts are not shared by WhatsApp or are not saved on the linked phone.` } : {})
      }
      this.#setContactSyncState(state)
      this.#emit({ type: 'contact.changed', payload: { chatIds: [], bulk: true } })
      return state
    })().catch((error) => {
      const state: ContactSyncState = { state: 'error', processed: this.#contactSyncState.processed,
        total: this.#contactSyncState.total, ...this.#resolvedContactCounts(), message: 'Contact names could not be refreshed.' }
      this.#setContactSyncState(state)
      this.#logger.error({ reason: error instanceof Error ? error.name : 'unknown' }, 'contact identity refresh failed')
      return state
    })
    this.#contactSyncPromise = operation
    try { return await operation }
    finally { this.#contactSyncPromise = undefined }
  }

  async #reconcileContactMappings(chatIds: string[], socket: WASocket, generation: number): Promise<number> {
    const lids = this.#database.listDirectLidChatIds(chatIds)
    if (!lids.length) return 0
    try {
      const mappings = await socket.signalRepository.lidMapping.getPNsForLIDs(lids) ?? []
      if (this.#socket !== socket || this.#socketGeneration !== generation) return 0
      const merges: Array<{ chatId: string; mergedChatIds: string[] }> = []
      this.#database.transaction(() => {
        for (const mapping of mappings) {
          const merge = this.#database.linkContactLid(mapping.lid, mapping.pn)
          if (merge) merges.push(merge)
        }
      })
      for (const merge of merges) this.#emit({ type: 'chat.merged', payload: merge })
      if (mappings.length) this.#emit({ type: 'contact.changed', payload: {
        chatIds: mappings.map((mapping) => this.#database.resolveChatId(mapping.lid))
      } })
      return mappings.length
    } catch (error) {
      this.#logger.warn({ reason: error instanceof Error ? error.name : 'unknown', count: lids.length },
        'stored LID contact mappings could not be reconciled')
      throw error
    }
  }

  async #hydrateContactAvatar(chatId: string, socket: WASocket, force = false): Promise<void> {
    const resolved = this.#database.resolveChatId(chatId)
    let chat: ContactDetails
    try { chat = this.#database.getContactDetails(resolved) }
    catch { return }
    if (chat.kind !== 'direct' || !this.#database.shouldRefreshContactAvatar(resolved, force)) return
    const pending = this.#avatarRequests.get(resolved)
    if (pending) return pending
    const operation = this.#enqueueAvatarTask(async () => {
      if (this.#socket !== socket) return
      try {
        const lookupJid = this.#database.contactLookupJid(resolved)
        const url = await socket.profilePictureUrl(lookupJid, 'preview', 8_000)
        if (!url) {
          this.#database.markContactAvatarMissing(resolved)
          this.#emit({ type: 'contact.changed', payload: { chatIds: [resolved] } })
          return
        }
        const token = await this.media.downloadAvatar(url)
        if (this.#socket !== socket) return
        this.#database.saveContactAvatar(resolved, token)
        this.#emit({ type: 'contact.changed', payload: { chatIds: [resolved] } })
      } catch (error) {
        const confirmedMissing = isConfirmedAvatarMissing(error)
        if (confirmedMissing) {
          this.#database.markContactAvatarMissing(resolved)
          this.#emit({ type: 'contact.changed', payload: { chatIds: [resolved] } })
        }
        else this.#database.markContactAvatarFailure(resolved)
        this.#logger.warn({ chatId: resolved, confirmedMissing, reason: errorDetails(error) }, 'contact avatar refresh failed')
      }
    })
    this.#avatarRequests.set(resolved, operation)
    try { await operation }
    finally { this.#avatarRequests.delete(resolved) }
  }

  #enqueueAvatarTask(task: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const run = (): void => {
        this.#activeAvatarRequests += 1
        void task().then(resolve, reject).finally(() => {
          this.#activeAvatarRequests -= 1
          this.#avatarQueue.shift()?.()
        })
      }
      if (this.#activeAvatarRequests < 4) run()
      else this.#avatarQueue.push(run)
    })
  }

  #resolvedContactCounts(): Pick<ContactSyncState, 'resolvedNames' | 'resolvedPhones' | 'savedNames' | 'profileNames'> {
    const coverage = this.#database.identityCoverage()
    return { resolvedNames: coverage.resolvedNames, resolvedPhones: coverage.resolvedPhones,
      savedNames: coverage.savedNames, profileNames: coverage.profileNames }
  }

  #setContactSyncState(state: ContactSyncState): void {
    this.#contactSyncState = state
    this.#emit({ type: 'contact.syncChanged', payload: this.contactSyncState })
  }

  async #refreshConversationMetadata(socket: WASocket, generation: number): Promise<void> {
    const metadataResults = await Promise.allSettled([
      socket.groupFetchAllParticipating(),
      socket.communityFetchAllParticipating()
    ])
    for (const [index, result] of metadataResults.entries()) {
      if (result.status === 'rejected') this.#logger.warn({ error: result.reason,
        source: index === 0 ? 'groups' : 'communities' }, 'conversation metadata refresh failed')
    }
    if (this.#socket !== socket || this.#socketGeneration !== generation) return
    for (const channelId of this.#database.listChannelIds()) {
      if (this.#socket !== socket || this.#socketGeneration !== generation) return
      await Promise.allSettled([
        this.#hydrateChannelMetadata(channelId, socket),
        socket.subscribeNewsletterUpdates(channelId)
      ])
      await delay(0)
    }
  }

  async #hydrateChannelMetadata(channelId: string, socket = this.#socket): Promise<void> {
    if (!socket || !channelId.endsWith('@newsletter')) return
    const existing = this.#channelMetadataRequests.get(channelId)
    if (existing) return existing
    const operation = (async (): Promise<void> => {
      try {
        const metadata = await socket.newsletterMetadata('jid', channelId)
        if (!metadata || this.#socket !== socket) return
        this.#database.upsertChat({
          id: channelId,
          title: metadata.name?.trim() || 'Channel',
          kind: 'channel',
          communityId: null,
          classificationKnown: true,
          description: metadata.description?.trim() || undefined,
          avatarUrl: metadata.picture?.url,
          mutedUntil: metadata.mute_state === 'ON' ? Number.MAX_SAFE_INTEGER : 0
        })
        this.#emit({ type: 'chat.changed', payload: { chatId: channelId } })
      } catch (error) {
        this.#logger.warn({ error, channelId }, 'channel metadata lookup failed')
      }
    })()
    this.#channelMetadataRequests.set(channelId, operation)
    try { await operation }
    finally { this.#channelMetadataRequests.delete(channelId) }
  }

  #handleDisconnect(error: unknown, socket: WASocket, generation: number): void {
    if (this.#manualLogout || this.#socket !== socket || this.#socketGeneration !== generation) return
    this.#socket = undefined
    this.#rejectHistoryRequests(new Error('Connection lost while loading earlier messages'))
    const statusCode = (error as any)?.output?.statusCode ?? (error as any)?.statusCode
    if (statusCode === DisconnectReason.loggedOut) {
      this.#database.clearAuth()
      this.#auth.state.creds = initAuthCreds()
      this.#setState({ phase: 'logged-out', accountState: this.#database.hasLinkedAccount() ? 'relink-required' : 'never-linked',
        message: 'This linked device was logged out.', qrDataUrl: undefined, pairingCode: undefined })
      return
    }
    if (statusCode === CLIENT_VERSION_REJECTED_STATUS) {
      this.#webVersion.invalidate()
      this.#logger.warn({ statusCode }, 'WhatsApp rejected the current Web client version')
      this.#setState({ phase: 'offline', message: 'WhatsApp compatibility changed. Refreshing and trying again...',
        qrDataUrl: undefined, pairingCode: undefined })
      this.#scheduleReconnect()
      return
    }
    this.#setState({ phase: 'offline', message: 'Connection lost. Reconnecting…', qrDataUrl: undefined, pairingCode: undefined })
    this.#scheduleReconnect()
  }

  #scheduleReconnect(): void {
    if (this.#manualLogout || this.#reconnectTimer) return
    const wait = Math.min(30_000, 1_000 * 2 ** this.#reconnectAttempt) + Math.floor(Math.random() * 500)
    this.#reconnectAttempt += 1
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      void this.connect().catch((cause) => {
        this.#logger.error({ cause }, 'reconnect failed')
        this.#setState({ phase: 'offline', message: 'Reconnect failed. Trying again…' })
        this.#scheduleReconnect()
      })
    }, wait)
  }

  #messageKey(messageId: string): WAMessage['key'] {
    const raw = this.#database.getRawMessage(messageId)
    if (!raw) throw new Error('The original message is unavailable')
    return deserializeRawMessage(raw).key
  }

  #requireSocket(): WASocket {
    if (!this.#socket || this.#state.phase !== 'connected') throw new Error('WhatsApp is offline')
    return this.#socket
  }

  #setState(patch: Partial<SessionState>): void {
    this.#state = { ...this.#state, ...patch }
    this.#logger.debug({ phase: this.#state.phase, accountState: this.#state.accountState }, 'session state changed')
    this.#emit({ type: 'session.changed', payload: this.state })
  }

  #setHistorySync(state: NonNullable<SessionState['historySync']>['state'], progress?: number): void {
    const current = this.#state.historySync ?? { state: 'idle' as const, progress: 0 }
    if (state === 'running' && (current.state === 'complete' || current.state === 'paused')) return
    const nextProgress = progress === undefined ? current.progress : Math.min(100, Math.max(current.progress, progress))
    this.#setState({ historySync: { state, progress: state === 'complete' ? 100 : nextProgress } })
  }

  #shouldDownloadHistory(notification: proto.Message.IHistorySyncNotification): boolean {
    return shouldDownloadInitialHistoryChunk(
      notification, this.#initialHistoryCutoff, this.#historyBoundaryTypes
    )
  }

  #resolveHistoryRequest(sessionId: string | null | undefined, messages: WAMessage[]): void {
    let requestId = sessionId ?? undefined
    let pending = requestId ? this.#historyRequests.get(requestId) : undefined
    if (!pending) {
      const chatIds = new Set(messages.map((message) => message.key.remoteJid).filter(Boolean)
        .map((chatId) => this.#database.resolveChatId(chatId!)))
      const match = [...this.#historyRequests.entries()].find(([, request]) => chatIds.has(request.chatId))
      requestId = match?.[0]
      pending = match?.[1]
    }
    if (!pending || !requestId) {
      this.#logger.warn({ sessionId, messageCount: messages.length }, 'received unmatched on-demand history')
      return
    }
    clearTimeout(pending.timer)
    this.#historyRequests.delete(requestId)
    const page = this.#database.listMessagesBefore(
      pending.chatId, pending.anchor.timestamp, pending.anchor.id, 50
    )
    pending.resolve({ items: page.items, hasMore: page.items.length === 50 })
  }

  #rejectHistoryRequest(sessionId: string | null | undefined, error: Error): void {
    if (!sessionId) return
    const pending = this.#historyRequests.get(sessionId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.#historyRequests.delete(sessionId)
    pending.reject(error)
  }

  #rejectHistoryRequests(error: Error): void {
    for (const request of this.#historyRequests.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.#historyRequests.clear()
  }
}

export async function addOrEditWhatsAppContact(socket: Pick<WASocket, 'addOrEditContact'>, targetJid: string,
  fullName: string, address: { phoneJid?: string; lidJid?: string }): Promise<void> {
  await socket.addOrEditContact(targetJid, {
    fullName,
    firstName: fullName.split(' ')[0],
    pnJid: address.phoneJid,
    lidJid: address.lidJid,
    saveOnPrimaryAddressbook: true
  })
}

export function isConfirmedAvatarMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as {
    message?: unknown
    statusCode?: unknown
    output?: { statusCode?: unknown }
    data?: { statusCode?: unknown } | number
  }
  const statusCode = Number(value.statusCode ?? value.output?.statusCode ??
    (typeof value.data === 'object' ? value.data?.statusCode : value.data))
  if (statusCode === 404) return true
  return typeof value.message === 'string' && /(?:\b404\b|not found|item-not-found)/i.test(value.message)
}

function errorDetails(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const value = error as Error & { code?: string | number; output?: { statusCode?: number } }
  const suffix = value.code ?? value.output?.statusCode
  return suffix === undefined ? error.message : `${error.message} (${suffix})`
}

function mediaContent(path: string, kind: string, caption?: string, fileName?: string, mimeType?: string): Record<string, unknown> {
  const url = { url: path }
  const normalizedMimeType = mimeType?.split(';', 1)[0]?.trim().toLowerCase()
  switch (kind) {
    case 'image': return { image: url, caption }
    case 'video': return { video: url, caption }
    case 'audio': return { audio: url, mimetype: normalizedMimeType?.startsWith('audio/') ? normalizedMimeType : mimeTypeForPath(path) }
    case 'voice': return { audio: url, ptt: true, mimetype: extname(path).toLowerCase() === '.ogg' ? 'audio/ogg; codecs=opus' : 'audio/webm; codecs=opus' }
    case 'sticker': return { sticker: url }
    default: return { document: url, fileName: safeAttachmentName(fileName) ?? basename(path),
      mimetype: normalizedMimeType || mimeTypeForPath(path), caption }
  }
}

function safeAttachmentName(fileName?: string): string | undefined {
  const name = fileName?.split(/[\\/]/).at(-1)?.trim()
  return name ? name.slice(0, 255) : undefined
}

function stableWhatsAppMessageId(clientId: string): string {
  return clientId.replaceAll('-', '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32).toUpperCase()
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function contactEventId(contact: Partial<Contact>): string | undefined {
  const explicit = contact.id?.trim() || contact.lid?.trim()
  return explicit || normalizeContactPhoneJid(contact.phoneNumber)
}

function normalizeContactPhoneJid(value?: string | null): string | undefined {
  const candidate = value?.trim()
  if (!candidate) return undefined
  if (candidate.endsWith('@s.whatsapp.net') || candidate.endsWith('@hosted')) return candidate
  const number = candidate.split('@')[0]?.split(':')[0]?.replace(/\D/g, '')
  return number ? `${number}@s.whatsapp.net` : undefined
}

export function normalizeContactIdentityInput(contact: Partial<Contact>): {
  id: string
  lid?: string
  phoneNumber?: string
  name?: string
  pushName?: string
  avatarUrl?: string
} | undefined {
  const id = contactEventId(contact)
  if (!id) return undefined
  const phoneJid = normalizeContactPhoneJid(contact.phoneNumber) ?? (isPhoneJid(id) ? id : undefined)
  return {
    id,
    lid: contact.lid?.trim() || (isLidJid(id) ? id : undefined),
    phoneNumber: phoneJid?.split('@')[0],
    name: contact.name?.trim() || undefined,
    pushName: contact.notify?.trim() || undefined,
    avatarUrl: typeof contact.imgUrl === 'string' && contact.imgUrl !== 'changed' ? contact.imgUrl : undefined
  }
}

function labelForJid(jid: string): string {
  if (jid.endsWith('@newsletter')) return 'Channel'
  if (jid.endsWith('@g.us')) return 'Group'
  if (isPhoneJid(jid)) return `+${(jid.split('@')[0] ?? jid).split(':')[0]}`
  return 'WhatsApp contact'
}
function isPhoneJid(jid?: string | null): jid is string {
  return Boolean(jid?.endsWith('@s.whatsapp.net') || jid?.endsWith('@hosted'))
}
function isLidJid(jid?: string | null): jid is string {
  return Boolean(jid?.endsWith('@lid') || jid?.endsWith('@hosted.lid'))
}
function directIdentityMapping(id?: string | null, lidJid?: string | null, phoneJid?: string | null): { lid: string; pn: string } | undefined {
  if (isLidJid(id) && isPhoneJid(phoneJid)) return { lid: id, pn: phoneJid }
  if (isPhoneJid(id) && isLidJid(lidJid)) return { lid: lidJid, pn: id }
  return undefined
}
function directIdentityPair(first?: string | null, second?: string | null): { lid: string; pn: string } | undefined {
  if (isLidJid(first) && isPhoneJid(second)) return { lid: first, pn: second }
  if (isPhoneJid(first) && isLidJid(second)) return { lid: second, pn: first }
  return undefined
}
function messageIdentityMappings(message: WAMessage): Array<{ lid: string; pn: string }> {
  const mappings = [
    directIdentityPair(message.key.remoteJid, message.key.remoteJidAlt),
    directIdentityPair(message.key.participant, message.key.participantAlt)
  ].filter((mapping): mapping is { lid: string; pn: string } => Boolean(mapping))
  return [...new Map(mappings.map((mapping) => [`${mapping.lid}|${mapping.pn}`, mapping])).values()]
}
function messageTimestampMs(message: WAMessage): number {
  const seconds = Number(message.messageTimestamp ?? 0)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now()
}

export function filterInitialHistoryMessages(messages: WAMessage[], cutoff: number): WAMessage[] {
  return messages.filter((message) => messageTimestampMs(message) >= cutoff)
}

export function shouldDownloadInitialHistoryChunk(
  notification: proto.Message.IHistorySyncNotification,
  cutoff: number,
  boundaryTypes: Set<number>
): boolean {
  const syncType = notification.syncType
  if (syncType === proto.Message.HistorySyncType.ON_DEMAND) return true
  if (syncType !== proto.Message.HistorySyncType.INITIAL_BOOTSTRAP &&
      syncType !== proto.Message.HistorySyncType.RECENT &&
      syncType !== proto.Message.HistorySyncType.FULL) return true
  if (Number(notification.progress) >= 100) return true
  const oldestTimestamp = Number(notification.oldestMsgInChunkTimestampSec ?? 0) * 1000
  if (!Number.isFinite(oldestTimestamp) || oldestTimestamp <= 0 || oldestTimestamp >= cutoff) return true
  if (boundaryTypes.has(syncType)) return false
  boundaryTypes.add(syncType)
  return true
}
