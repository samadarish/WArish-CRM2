import type { Logger } from 'pino'
import type { AppError, AppSettings, CoreEventEnvelope, DraftDto, PickedAttachment, RpcMethod } from '../shared/contracts'
import { WarishDatabase } from './database'
import { flushCoreLogger, readErrorLogs } from './logger'
import { MediaManager } from './media-manager'
import { WhatsAppClient } from './whatsapp-client'

type EmitEvent = (event: CoreEventEnvelope) => void

export class RpcRouter {
  readonly #database: WarishDatabase
  readonly #whatsapp: WhatsAppClient
  readonly #media: MediaManager
  readonly #emit: EmitEvent
  readonly #runtime: { appVersion: string; electronVersion: string; nodeVersion: string; logDirectory: string }
  readonly #logger: Logger

  constructor(
    database: WarishDatabase,
    whatsapp: WhatsAppClient,
    media: MediaManager,
    emit: EmitEvent,
    logger: Logger,
    runtime: { appVersion: string; electronVersion: string; nodeVersion: string; logDirectory: string }
  ) {
    this.#database = database
    this.#whatsapp = whatsapp
    this.#media = media
    this.#emit = emit
    this.#logger = logger
    this.#runtime = runtime
  }

  async handle(method: RpcMethod, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'session.getState': return this.#whatsapp.state
      case 'session.startQr': return this.#whatsapp.connect()
      case 'session.requestPairingCode': return this.#whatsapp.requestPairingCode(requiredString(params, 'phoneNumber'))
      case 'session.reconnect': return this.#whatsapp.connect()
      case 'session.prepareRelink': return this.#whatsapp.prepareRelink()
      case 'session.logout': {
        await this.#whatsapp.logout()
        if (params.eraseLocalData === true) {
          this.#database.resetUserData()
          this.#media.clear()
        }
        return undefined
      }
      case 'chat.list': return this.#database.listChats({
        cursor: optionalString(params.cursor), limit: optionalNumber(params.limit), archived: optionalBoolean(params.archived),
        query: optionalString(params.query), category: chatCategory(params.category)
      })
      case 'chat.get': return this.#whatsapp.getChat(requiredString(params, 'chatId'))
      case 'chat.update': {
        const patch = objectValue(params.patch)
        const chatId = requiredString(params, 'chatId')
        this.#database.updateChat(chatId, {
          archived: optionalBoolean(patch.archived), pinned: optionalBoolean(patch.pinned), mutedUntil: optionalNumber(patch.mutedUntil)
        })
        this.#emit({ type: 'chat.changed', payload: { chatId } })
        return undefined
      }
      case 'chat.markRead': return this.#whatsapp.markRead(requiredString(params, 'chatId'))
      case 'contacts.get': return this.#whatsapp.getContact(requiredString(params, 'chatId'))
      case 'contacts.hydrate': return this.#whatsapp.hydrateContacts(stringArray(params.chatIds))
      case 'contacts.refresh': return this.#whatsapp.refreshContacts()
      case 'contacts.getSyncState': return this.#whatsapp.contactSyncState
      case 'community.list': return this.#database.listCommunities({
        cursor: optionalString(params.cursor), limit: optionalNumber(params.limit), query: optionalString(params.query)
      })
      case 'message.list': return this.#database.listMessages(requiredString(params, 'chatId'), optionalString(params.before), optionalNumber(params.limit))
      case 'message.context': return this.#database.getMessageContext(
        requiredString(params, 'chatId'), requiredString(params, 'messageId'), optionalNumber(params.radius)
      )
      case 'message.loadEarlier': return this.#whatsapp.loadEarlier(requiredString(params, 'chatId'))
      case 'message.send': {
        const input = objectValue(params.input)
        return this.#whatsapp.send({
          chatId: requiredString(input, 'chatId'), clientId: requiredString(input, 'clientId'), text: optionalString(input.text),
          attachmentToken: optionalString(input.attachmentToken), attachmentKind: attachmentKind(input.attachmentKind),
          quotedMessageId: optionalString(input.quotedMessageId)
        })
      }
      case 'message.retry': return this.#whatsapp.retry(requiredString(params, 'messageId'))
      case 'message.react': return this.#whatsapp.react(requiredString(params, 'chatId'), requiredString(params, 'messageId'), optionalString(params.emoji))
      case 'message.edit': return this.#whatsapp.edit(requiredString(params, 'chatId'), requiredString(params, 'messageId'), requiredString(params, 'text'))
      case 'message.delete': return this.#whatsapp.delete(requiredString(params, 'chatId'), requiredString(params, 'messageId'), deleteMode(params.mode))
      case 'message.forward': return this.#whatsapp.forward(requiredString(params, 'messageId'), stringArray(params.chatIds))
      case 'media.download': {
        const socket = this.#whatsapp.socket
        if (!socket) throw new Error('WhatsApp is offline')
        const token = await this.#media.download(requiredString(params, 'messageId'), socket)
        return { cacheToken: token, url: `warish-media://cache/${encodeURIComponent(token)}` }
      }
      case 'media.cancel': this.#media.cancel(requiredString(params, 'messageId')); return undefined
      case 'media.clearCache': this.#media.clear(); return undefined
      case 'media.discardDraft': this.#media.discardDraft(requiredString(params, 'token')); return undefined
      case 'search.messages': return this.#database.searchMessages(requiredString(params, 'query'), optionalString(params.chatId), optionalString(params.cursor))
      case 'draft.get': return this.#database.getDraft(requiredString(params, 'chatId'))
      case 'draft.save': {
        const draft = objectValue(params.draft)
        const attachment = optionalAttachment(draft.attachment)
        this.#database.saveDraft({
          chatId: requiredString(draft, 'chatId'),
          text: optionalString(draft.text) ?? '',
          attachment,
          attachmentKind: attachmentKind(draft.attachmentKind),
          updatedAt: optionalNumber(draft.updatedAt) ?? Date.now()
        } satisfies DraftDto)
        return undefined
      }
      case 'draft.clear': this.#database.clearDraft(requiredString(params, 'chatId')); return undefined
      case 'settings.get': return this.#database.getSettings()
      case 'settings.update': {
        const patch = objectValue(params.patch)
        const settings = this.#database.updateSettings({
          theme: themeValue(patch.theme), density: densityValue(patch.density),
          notificationPreview: optionalBoolean(patch.notificationPreview),
          enterToSend: optionalBoolean(patch.enterToSend), showChatPreviews: optionalBoolean(patch.showChatPreviews),
          reduceMotion: optionalBoolean(patch.reduceMotion), conversationBackground: conversationBackgroundValue(patch.conversationBackground),
          cacheLimitBytes: optionalNumber(patch.cacheLimitBytes), launchAtLogin: optionalBoolean(patch.launchAtLogin),
          historySyncDays: optionalNumber(patch.historySyncDays), navigationMode: navigationModeValue(patch.navigationMode)
        })
        this.#media.enforceLimit(settings.cacheLimitBytes)
        this.#emit({ type: 'settings.changed', payload: settings })
        return settings
      }
      case 'diagnostics.get': return {
        ...this.#runtime,
        sessionPhase: this.#whatsapp.state.phase,
        databaseBytes: this.#database.sizeBytes(),
        mediaCacheBytes: this.#media.sizeBytes(),
        identityCoverage: this.#database.identityCoverage()
      }
      case 'diagnostics.logs': {
        try { await flushCoreLogger(this.#logger) }
        catch { /* Reading existing entries is still useful if the final flush fails. */ }
        return readErrorLogs(this.#runtime.logDirectory, optionalNumber(params.limit))
      }
      case 'diagnostics.reportRendererError': {
        this.#logger.error({ rendererContext: optionalString(params.context)?.slice(0, 4_000) },
          optionalString(params.message)?.slice(0, 1_000) || 'Renderer error')
        return undefined
      }
    }
  }
}

export function toAppError(error: unknown): AppError {
  const message = error instanceof Error ? error.message : 'Unexpected application error'
  if (/offline|connection/i.test(message)) return { code: 'OFFLINE', message, retryable: true }
  if (/not found|unavailable/i.test(message)) return { code: 'NOT_FOUND', message, retryable: false }
  if (/invalid|valid international|cannot be empty/i.test(message)) return { code: 'INVALID_INPUT', message, retryable: false }
  if (/logged out|auth/i.test(message)) return { code: 'AUTH_LOST', message, retryable: false }
  return { code: 'INTERNAL', message, retryable: false }
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${key}`)
  return value
}

function chatCategory(value: unknown): 'all' | 'direct' | 'group' | 'community' | 'channel' | undefined {
  return value === 'all' || value === 'direct' || value === 'group' || value === 'community' || value === 'channel'
    ? value
    : undefined
}
function optionalString(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
function optionalNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
function optionalBoolean(value: unknown): boolean | undefined { return typeof value === 'boolean' ? value : undefined }
function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request payload')
  return value as Record<string, unknown>
}
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) throw new Error('Invalid chatIds')
  return value
}
function attachmentKind(value: unknown): 'image' | 'video' | 'document' | 'audio' | 'voice' | 'sticker' | undefined {
  return value === 'image' || value === 'video' || value === 'document' || value === 'audio' || value === 'voice' || value === 'sticker'
    ? value
    : undefined
}
function deleteMode(value: unknown): 'for-me' | 'for-everyone' { return value === 'for-everyone' ? value : 'for-me' }
function themeValue(value: unknown): AppSettings['theme'] | undefined {
  return ['system', 'light', 'dark', 'black'].includes(String(value)) ? value as AppSettings['theme'] : undefined
}
function densityValue(value: unknown): AppSettings['density'] | undefined {
  return value === 'comfortable' || value === 'compact' ? value : undefined
}
function navigationModeValue(value: unknown): AppSettings['navigationMode'] | undefined {
  return value === 'auto' || value === 'expanded' || value === 'collapsed' ? value : undefined
}
function conversationBackgroundValue(value: unknown): AppSettings['conversationBackground'] | undefined {
  return value === 'subtle' || value === 'plain' || value === 'grid' ? value : undefined
}
function optionalAttachment(value: unknown): PickedAttachment | undefined {
  if (value === undefined || value === null) return undefined
  const input = objectValue(value)
  return {
    token: requiredString(input, 'token'),
    name: requiredString(input, 'name'),
    size: optionalNumber(input.size) ?? 0,
    mimeType: requiredString(input, 'mimeType'),
    previewUrl: requiredString(input, 'previewUrl')
  }
}
