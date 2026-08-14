import type { Logger } from 'pino'
import type {
  AppError, AppSettings, ChatCrmStageFilter, CoreEventEnvelope, CrmCatalogItemDto, CrmContactPatch, CrmLifecycle, CrmNoteInput, CrmOrderInput,
  CrmOrderItemDto, CrmPaymentDto, CrmTaskDto, CrmTaskInput, DraftDto, PickedAttachment, RpcMethod
} from '../shared/contracts'
import { WarishDatabase } from './database'
import { ContactRestrictedError, CrmRepository } from './crm-repository'
import { flushCoreLogger, readErrorLogs } from './logger'
import { MediaManager } from './media-manager'
import { WhatsAppClient } from './whatsapp-client'

type EmitEvent = (event: CoreEventEnvelope) => void

export class RpcRouter {
  readonly #database: WarishDatabase
  readonly #whatsapp: WhatsAppClient
  readonly #media: MediaManager
  readonly #crm: CrmRepository
  readonly #emit: EmitEvent
  readonly #runtime: { appVersion: string; electronVersion: string; nodeVersion: string; logDirectory: string }
  readonly #logger: Logger

  constructor(
    database: WarishDatabase,
    whatsapp: WhatsAppClient,
    media: MediaManager,
    crm: CrmRepository,
    emit: EmitEvent,
    logger: Logger,
    runtime: { appVersion: string; electronVersion: string; nodeVersion: string; logDirectory: string }
  ) {
    this.#database = database
    this.#whatsapp = whatsapp
    this.#media = media
    this.#crm = crm
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
        query: optionalString(params.query), category: chatCategory(params.category), crmStage: chatCrmStageFilter(params.crmStage)
      })
      case 'chat.get': return this.#whatsapp.getChat(requiredString(params, 'chatId'))
      case 'chat.getMany': return this.#database.getChats(stringArray(params.chatIds))
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
      case 'contacts.save': return this.#whatsapp.saveContact(requiredString(params, 'chatId'),
        requiredString(objectValue(params.input), 'fullName'))
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
        const chatId = requiredString(input, 'chatId')
        this.#crm.assertCanContact(chatId, optionalBoolean(input.restrictedContactAcknowledged) ?? false)
        return this.#whatsapp.send({
          chatId, clientId: requiredString(input, 'clientId'), text: optionalString(input.text),
          attachmentToken: optionalString(input.attachmentToken), attachmentKind: attachmentKind(input.attachmentKind),
          quotedMessageId: optionalString(input.quotedMessageId)
        })
      }
      case 'message.retry': return this.#whatsapp.retry(requiredString(params, 'messageId'))
      case 'message.react': return this.#whatsapp.react(requiredString(params, 'chatId'), requiredString(params, 'messageId'), optionalString(params.emoji))
      case 'message.edit': return this.#whatsapp.edit(requiredString(params, 'chatId'), requiredString(params, 'messageId'), requiredString(params, 'text'))
      case 'message.delete': return this.#whatsapp.delete(requiredString(params, 'chatId'), requiredString(params, 'messageId'), deleteMode(params.mode))
      case 'message.forward': {
        const chatIds = stringArray(params.chatIds)
        const acknowledgements = new Set(optionalStringArray(params.restrictedContactAcknowledgements))
        for (const chatId of chatIds) {
          const resolvedChatId = this.#database.resolveChatId(chatId)
          this.#crm.assertCanContact(chatId, acknowledgements.has(chatId) || acknowledgements.has(resolvedChatId))
        }
        return this.#whatsapp.forward(requiredString(params, 'messageId'), chatIds)
      }
      case 'media.thumbnail': {
        const messageId = requiredString(params, 'messageId')
        const thumbnailDataUrl = await this.#media.thumbnail(messageId)
        if (thumbnailDataUrl) this.#emit({ type: 'message.changed', payload: { message: this.#database.getMessage(messageId) } })
        return { thumbnailDataUrl }
      }
      case 'media.download': {
        const socket = this.#whatsapp.socket
        if (!socket) throw new Error('WhatsApp is offline')
        const messageId = requiredString(params, 'messageId')
        const token = await this.#media.download(messageId, socket)
        this.#emit({ type: 'message.changed', payload: { message: this.#database.getMessage(messageId) } })
        return { cacheToken: token, url: `warish-media://cache/${encodeURIComponent(token)}` }
      }
      case 'media.cancel': this.#media.cancel(requiredString(params, 'messageId')); return undefined
      case 'media.clearCache': this.#media.clear(); return undefined
      case 'media.discardDraft': this.#media.discardDraft(requiredString(params, 'token')); return undefined
      case 'crm.dashboard.get': return this.#crm.dashboard()
      case 'crm.pipeline.get': return this.#crm.pipeline()
      case 'crm.contacts.list': {
        const input = params.input === undefined ? params : objectValue(params.input)
        return this.#crm.listContacts({ lifecycle: crmLifecycleFilter(input.lifecycle), stageId: optionalString(input.stageId),
          query: optionalString(input.query), limit: optionalNumber(input.limit) })
      }
      case 'crm.contacts.get': return this.#crm.getContact({
        contactId: optionalString(params.contactId), chatId: optionalString(params.chatId)
      })
      case 'crm.contacts.ensure': return this.#crm.ensureContact(requiredString(params, 'chatId'))
      case 'crm.contacts.update': return this.#crm.updateContact(requiredString(params, 'contactId'),
        crmContactPatch(objectValue(params.patch)))
      case 'crm.contacts.setStage': return this.#crm.setStage(requiredString(params, 'contactId'), requiredString(params, 'stageId'))
      case 'crm.contacts.setLifecycle': return this.#crm.setLifecycle(requiredString(params, 'contactId'), crmLifecycle(params.lifecycle))
      case 'crm.notes.list': return this.#crm.listNotes(requiredString(params, 'contactId'))
      case 'crm.notes.add': return this.#crm.addNote(requiredString(params, 'contactId'), requiredString(params, 'body'),
        optionalString(params.sourceMessageId))
      case 'crm.notes.save': return this.#crm.saveNote(crmNoteInput(objectValue(params.input)))
      case 'crm.notes.delete': this.#crm.deleteNote(requiredString(params, 'noteId')); return undefined
      case 'crm.tasks.list': {
        const input = params.input === undefined ? params : objectValue(params.input)
        return this.#crm.listTasks({ contactId: optionalString(input.contactId), status: taskStatus(input.status), due: taskDue(input.due) })
      }
      case 'crm.tasks.save': return this.#crm.saveTask(crmTaskInput(objectValue(params.input)))
      case 'crm.tasks.delete': this.#crm.deleteTask(requiredString(params, 'taskId')); return undefined
      case 'crm.catalog.list': return this.#crm.listCatalog(optionalString(params.query), optionalBoolean(params.includeInactive) ?? false)
      case 'crm.catalog.save': return this.#crm.saveCatalog(crmCatalogInput(objectValue(params.input)))
      case 'crm.catalog.delete': this.#crm.deleteCatalog(requiredString(params, 'itemId')); return undefined
      case 'crm.orders.list': return this.#crm.listOrders(optionalString(params.contactId))
      case 'crm.orders.get': return this.#crm.getOrder(requiredString(params, 'orderId'))
      case 'crm.orders.save': return this.#crm.saveOrder(crmOrderInput(objectValue(params.input)))
      case 'crm.orders.delete': this.#crm.deleteOrder(requiredString(params, 'orderId')); return undefined
      case 'crm.activity.list': return this.#crm.activity(requiredString(params, 'contactId'), optionalNumber(params.limit))
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
  if (error instanceof ContactRestrictedError) return { code: 'CONTACT_RESTRICTED', message, retryable: false }
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
function chatCrmStageFilter(value: unknown): ChatCrmStageFilter | undefined {
  return value === 'all' || value === 'new' || value === 'won' || value === 'lost' ? value : undefined
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
function optionalStringArray(value: unknown): string[] {
  return value === undefined ? [] : stringArray(value)
}
function attachmentKind(value: unknown): 'image' | 'video' | 'document' | 'audio' | 'voice' | 'sticker' | undefined {
  return value === 'image' || value === 'video' || value === 'document' || value === 'audio' || value === 'voice' || value === 'sticker'
    ? value
    : undefined
}
function deleteMode(value: unknown): 'for-me' | 'for-everyone' {
  if (value === 'for-me' || value === 'for-everyone') return value
  throw new Error('Invalid delete mode')
}
function themeValue(value: unknown): AppSettings['theme'] | undefined {
  return ['system', 'light', 'dark', 'black', 'salesforce-black'].includes(String(value)) ? value as AppSettings['theme'] : undefined
}
function densityValue(value: unknown): AppSettings['density'] | undefined {
  return value === 'comfortable' || value === 'compact' || value === 'dense' || value === 'ultra-dense' ? value : undefined
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

function crmLifecycle(value: unknown): CrmLifecycle {
  if (value === 'lead' || value === 'customer' || value === 'ignored' || value === 'spam') return value
  throw new Error('Invalid lifecycle')
}
function crmLifecycleFilter(value: unknown): CrmLifecycle | 'active' | undefined {
  return value === 'active' ? value : value === undefined ? undefined : crmLifecycle(value)
}
function taskStatus(value: unknown): CrmTaskDto['status'] | undefined {
  return value === 'open' || value === 'completed' || value === 'cancelled' ? value : undefined
}
function taskDue(value: unknown): 'overdue' | 'today' | 'upcoming' | undefined {
  return value === 'overdue' || value === 'today' || value === 'upcoming' ? value : undefined
}
function taskPriority(value: unknown): CrmTaskDto['priority'] | undefined {
  return value === 'low' || value === 'normal' || value === 'high' ? value : undefined
}
function crmContactPatch(input: Record<string, unknown>): CrmContactPatch {
  const patch: CrmContactPatch = {}
  for (const key of ['name', 'email', 'company', 'address', 'birthday', 'taxId', 'preferences', 'source'] as const) {
    if (key in input) patch[key] = optionalString(input[key]) ?? ''
  }
  if ('consentStatus' in input) {
    if (input.consentStatus !== 'unknown' && input.consentStatus !== 'granted' && input.consentStatus !== 'denied') {
      throw new Error('Invalid consent status')
    }
    patch.consentStatus = input.consentStatus
  }
  if ('doNotContact' in input) {
    const value = optionalBoolean(input.doNotContact)
    if (value === undefined) throw new Error('Invalid do-not-contact value')
    patch.doNotContact = value
  }
  if ('customFields' in input) patch.customFields = optionalStringRecord(input.customFields) ?? {}
  if ('tags' in input) patch.tags = optionalTags(input.tags) ?? []
  return patch
}
function crmNoteInput(input: Record<string, unknown>): CrmNoteInput {
  return { id: optionalString(input.id), contactId: requiredString(input, 'contactId'), body: requiredString(input, 'body'),
    sourceMessageId: optionalString(input.sourceMessageId) }
}
function crmTaskInput(input: Record<string, unknown>): CrmTaskInput {
  return {
    id: optionalString(input.id), contactId: requiredString(input, 'contactId'), orderId: optionalString(input.orderId),
    title: requiredString(input, 'title'), description: optionalString(input.description), dueAt: optionalNumber(input.dueAt),
    priority: taskPriority(input.priority), status: taskStatus(input.status), reminderAt: optionalNumber(input.reminderAt),
    sourceMessageId: optionalString(input.sourceMessageId)
  }
}
function crmCatalogInput(input: Record<string, unknown>): Partial<CrmCatalogItemDto> & Pick<CrmCatalogItemDto, 'type' | 'name' | 'unitPrice'> {
  if (input.type !== 'product' && input.type !== 'service') throw new Error('Invalid catalog type')
  return {
    id: optionalString(input.id), type: input.type, name: requiredString(input, 'name'),
    sku: optionalString(input.sku), description: optionalString(input.description), unitPrice: requiredNumber(input, 'unitPrice'),
    currency: optionalString(input.currency), active: optionalBoolean(input.active)
  }
}
function crmOrderInput(input: Record<string, unknown>): CrmOrderInput {
  if (!['draft', 'confirmed', 'in-progress', 'completed', 'cancelled'].includes(String(input.status))) throw new Error('Invalid order status')
  if (!Array.isArray(input.items)) throw new Error('Invalid order items')
  if (input.payments !== undefined && !Array.isArray(input.payments)) throw new Error('Invalid order payments')
  return {
    id: optionalString(input.id), contactId: requiredString(input, 'contactId'), status: input.status as CrmOrderInput['status'],
    currency: optionalString(input.currency), shippingAddress: optionalString(input.shippingAddress),
    appointmentAt: optionalNumber(input.appointmentAt), expectedAt: optionalNumber(input.expectedAt),
    customerNote: optionalString(input.customerNote), internalNote: optionalString(input.internalNote),
    items: input.items.map((item) => crmOrderItem(objectValue(item))),
    payments: input.payments?.map((payment) => crmPayment(objectValue(payment)))
  }
}
function crmOrderItem(input: Record<string, unknown>): Omit<CrmOrderItemDto, 'id' | 'lineTotal'> {
  if (input.type !== 'product' && input.type !== 'service') throw new Error('Invalid order item type')
  return { catalogItemId: optionalString(input.catalogItemId), type: input.type, name: requiredString(input, 'name'),
    sku: optionalString(input.sku), quantity: requiredNumber(input, 'quantity'), unitPrice: requiredNumber(input, 'unitPrice'),
    discount: optionalNumber(input.discount) ?? 0, taxRate: optionalNumber(input.taxRate) ?? 0 }
}
function crmPayment(input: Record<string, unknown>): Omit<CrmPaymentDto, 'id'> {
  return { amount: requiredNumber(input, 'amount'), method: optionalString(input.method), reference: optionalString(input.reference),
    paidAt: optionalNumber(input.paidAt) ?? Date.now(), note: optionalString(input.note) }
}
function requiredNumber(input: Record<string, unknown>, key: string): number {
  const value = optionalNumber(input[key])
  if (value === undefined) throw new Error(`Invalid ${key}`)
  return value
}
function optionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const input = objectValue(value)
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(input)) {
    if (typeof entry !== 'string') throw new Error('Invalid custom fields')
    result[key] = entry
  }
  return result
}
function optionalTags(value: unknown): Array<{ name: string; color?: string }> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('Invalid tags')
  return value.map((entry) => {
    const input = objectValue(entry)
    return { name: requiredString(input, 'name'), color: optionalString(input.color) }
  })
}
