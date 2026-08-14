import { z } from 'zod'

export const RPC_METHODS = [
  'session.getState',
  'session.startQr',
  'session.requestPairingCode',
  'session.reconnect',
  'session.prepareRelink',
  'session.logout',
  'chat.list',
  'chat.get',
  'chat.getMany',
  'chat.update',
  'chat.markRead',
  'contacts.get',
  'contacts.save',
  'contacts.hydrate',
  'contacts.refresh',
  'contacts.getSyncState',
  'community.list',
  'message.list',
  'message.context',
  'message.loadEarlier',
  'message.send',
  'message.retry',
  'message.react',
  'message.edit',
  'message.delete',
  'message.forward',
  'media.thumbnail',
  'media.download',
  'media.cancel',
  'media.clearCache',
  'media.discardDraft',
  'crm.dashboard.get',
  'crm.pipeline.get',
  'crm.contacts.list',
  'crm.contacts.get',
  'crm.contacts.ensure',
  'crm.contacts.update',
  'crm.contacts.setStage',
  'crm.contacts.setLifecycle',
  'crm.notes.list',
  'crm.notes.add',
  'crm.notes.save',
  'crm.notes.delete',
  'crm.tasks.list',
  'crm.tasks.save',
  'crm.tasks.delete',
  'crm.catalog.list',
  'crm.catalog.save',
  'crm.catalog.delete',
  'crm.orders.list',
  'crm.orders.get',
  'crm.orders.save',
  'crm.orders.delete',
  'crm.activity.list',
  'search.messages',
  'draft.get',
  'draft.save',
  'draft.clear',
  'settings.get',
  'settings.update',
  'diagnostics.get',
  'diagnostics.logs',
  'diagnostics.reportRendererError'
] as const

export type RpcMethod = (typeof RPC_METHODS)[number]

export const rpcInvocationSchema = z.object({
  method: z.enum(RPC_METHODS),
  params: z.record(z.string(), z.unknown()).default({})
})

export interface RpcRequest {
  id: string
  method: RpcMethod
  params: Record<string, unknown>
}

export interface RpcResponse {
  id: string
  ok: boolean
  data?: unknown
  error?: AppError
}

export interface CoreEventPayloadMap {
  'session.changed': SessionState
  'sync.progress': { processed: number; total: number; skipped: number; historyDays: number }
  'history.batch': HistoryBatchEvent
  'chat.changed': { chatId?: string; bulk?: boolean }
  'chat.merged': ChatMergedEvent
  'contact.changed': { chatIds: string[]; bulk?: boolean }
  'contact.syncChanged': ContactSyncState
  'message.upserted': MessageDto
  'message.changed': { message: MessageDto; replacedId?: string }
  'message.batch': { messages: MessageDto[] }
  'message.statusChanged': { chatId: string; messageId: string; status: DeliveryState }
  'presence.changed': unknown
  'media.progress': unknown
  'settings.changed': AppSettings
  'navigation.openChat': { chatId: string }
  'navigation.openCrm': { contactId: string }
  'crm.changed': { contactId?: string; chatId?: string; scope: 'contact' | 'pipeline' | 'order' | 'task' | 'catalog' | 'all' }
  'crm.taskDue': { taskId: string; contactId: string; title: string; dueAt: number }
}

export type CoreEventType = keyof CoreEventPayloadMap
export type CoreEventEnvelope = {
  [Type in CoreEventType]: { type: Type; payload: CoreEventPayloadMap[Type] }
}[CoreEventType]

export type SessionPhase =
  | 'starting'
  | 'unlinked'
  | 'pairing'
  | 'connecting'
  | 'syncing'
  | 'connected'
  | 'offline'
  | 'logged-out'
  | 'error'

export interface SessionState {
  phase: SessionPhase
  accountState: 'never-linked' | 'linked' | 'relink-required'
  qrDataUrl?: string
  pairingCode?: string
  phoneNumber?: string
  message?: string
  syncProgress?: number
  historySync?: HistorySyncState
}

export interface HistorySyncState {
  state: 'idle' | 'running' | 'complete' | 'paused'
  progress: number
}

export interface HistoryBatchEvent {
  chatIds: string[]
  messageCount: number
  onDemand: boolean
}

export interface ChatMergedEvent {
  chatId: string
  mergedChatIds: string[]
}

export interface ContactDetails {
  chatId: string
  kind: ChatKind
  title: string
  savedName?: string
  whatsappName?: string
  phoneNumber?: string
  avatarUrl?: string
  communityId?: string
  description?: string
  pinned: boolean
  archived: boolean
  mutedUntil?: number
}

export interface ContactSyncState {
  state: 'idle' | 'running' | 'complete' | 'partial' | 'error'
  processed: number
  total: number
  resolvedNames: number
  resolvedPhones: number
  savedNames: number
  profileNames: number
  message?: string
}

export type ChatKind = 'direct' | 'group' | 'community' | 'channel' | 'broadcast' | 'unknown'
export type ChatCategory = 'all' | 'direct' | 'group' | 'community' | 'channel'
export type ChatCrmStageFilter = 'all' | 'new' | 'won' | 'lost'

export interface ChatSummary {
  id: string
  title: string
  kind: ChatKind
  savedName?: string
  whatsappName?: string
  phoneNumber?: string
  communityId?: string
  isAnnouncement?: boolean
  readOnly?: boolean
  description?: string
  avatarUrl?: string
  lastMessage?: string
  lastMessageAt?: number
  lastMessageId?: string
  lastMessageFromMe?: boolean
  lastMessageStatus?: DeliveryState
  unreadCount: number
  archived: boolean
  pinned: boolean
  mutedUntil?: number
  typing?: boolean
  crm?: CrmChatIndicatorDto
}

export interface CommunitySummary {
  id: string
  title: string
  avatarUrl?: string
  lastMessageAt?: number
  unreadCount: number
  children: ChatSummary[]
}

export type MessageKind =
  | 'text'
  | 'image'
  | 'video'
  | 'document'
  | 'audio'
  | 'voice'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'poll'
  | 'rich'
  | 'system'
  | 'unsupported'

export type DeliveryState = 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed'

export interface AttachmentDto {
  id: string
  messageId: string
  kind: 'image' | 'video' | 'document' | 'audio' | 'voice' | 'sticker' | 'location' | 'contact' | 'poll'
  fileName?: string
  mimeType?: string
  size?: number
  width?: number
  height?: number
  durationSeconds?: number
  thumbnailDataUrl?: string
  cacheToken?: string
  draftToken?: string
  downloadState: 'remote' | 'downloading' | 'ready' | 'failed'
}

export interface QuotedMessageDto {
  id: string
  senderName?: string
  fromMe?: boolean
  kind: MessageKind
  text?: string
}

export interface RichMessageDto {
  type: 'template' | 'product' | 'album' | 'comment' | 'interactive' | 'poll-update' | 'unknown'
  title?: string
  body?: string
  footer?: string
  itemCount?: number
}

export interface MessageDto {
  id: string
  chatId: string
  senderId?: string
  senderName?: string
  fromMe: boolean
  kind: MessageKind
  text?: string
  timestamp: number
  status: DeliveryState
  quotedMessageId?: string
  quoted?: QuotedMessageDto
  rich?: RichMessageDto
  edited: boolean
  deleted: boolean
  reactions: Array<{ senderId: string; emoji: string }>
  attachment?: AttachmentDto
  clientId?: string
  error?: string
}

export interface Page<T> {
  items: T[]
  nextCursor?: string
}

export interface OlderHistoryResult {
  items: MessageDto[]
  hasMore: boolean
}

export interface MessageContextDto {
  targetId: string
  items: MessageDto[]
}

export interface PickedAttachment {
  token: string
  name: string
  size: number
  mimeType: string
  previewUrl: string
}

export interface DraftDto {
  chatId: string
  text: string
  attachment?: PickedAttachment
  attachmentKind?: 'image' | 'video' | 'document' | 'audio' | 'voice' | 'sticker'
  updatedAt: number
}

export type CrmLifecycle = 'lead' | 'customer' | 'ignored' | 'spam'
export type CrmStageKey = 'new' | 'qualified' | 'quoted' | 'won' | 'lost'

export interface CrmChatIndicatorDto {
  contactId: string
  name?: string
  lifecycle: CrmLifecycle
  stageId: string
  stageKey: CrmStageKey
  stageName: string
  stageColor: string
  openTaskCount: number
  nextTask?: {
    id: string
    title: string
    dueAt?: number
    priority: CrmTaskDto['priority']
  }
  restricted: boolean
}

export interface CrmStageDto {
  id: string
  key: CrmStageKey
  name: string
  color: string
  position: number
  outcome: 'open' | 'won' | 'lost'
}

export interface CrmTagDto {
  id: string
  name: string
  color: string
}

export interface CrmContactSummaryDto {
  id: string
  identityId: string
  chatId: string
  lifecycle: CrmLifecycle
  stageId: string
  stageKey: CrmStageKey
  stageName: string
  stageColor: string
  name: string
  whatsappName?: string
  phoneNumber?: string
  avatarUrl?: string
  company?: string
  source: string
  tags: CrmTagDto[]
  createdAt: number
  lastActivityAt: number
  orderCount: number
  lifetimeValue: number
  openTaskCount: number
}

export interface CrmContactDetailsDto extends CrmContactSummaryDto {
  email?: string
  address?: string
  birthday?: string
  taxId?: string
  preferences?: string
  consentStatus: 'unknown' | 'granted' | 'denied'
  doNotContact: boolean
  customFields: Record<string, string>
}

export interface CrmDashboardDto {
  newLeads: number
  openLeads: number
  customers: number
  overdueTasks: number
  ordersThisMonth: number
  revenueThisMonth: number
  lifetimeRevenue: number
  recentContacts: CrmContactSummaryDto[]
  pipeline: Array<CrmStageDto & { count: number; value: number }>
}

export interface CrmMessageReferenceDto {
  messageId: string
  chatId: string
  senderId?: string
  senderName?: string
  fromMe: boolean
  kind: MessageKind
  text?: string
  timestamp: number
}

export interface CrmNoteDto {
  id: string
  contactId: string
  body: string
  sourceMessageId?: string
  sourceMessage?: CrmMessageReferenceDto
  createdAt: number
  updatedAt: number
}

export interface CrmNoteInput {
  id?: string
  contactId: string
  body: string
  sourceMessageId?: string
}

export interface CrmTaskDto {
  id: string
  contactId: string
  orderId?: string
  title: string
  description?: string
  dueAt?: number
  priority: 'low' | 'normal' | 'high'
  status: 'open' | 'completed' | 'cancelled'
  reminderAt?: number
  notifiedAt?: number
  sourceMessageId?: string
  sourceMessage?: CrmMessageReferenceDto
  createdAt: number
  completedAt?: number
}

export interface CrmTaskInput {
  id?: string
  contactId: string
  orderId?: string
  title: string
  description?: string
  dueAt?: number
  priority?: CrmTaskDto['priority']
  status?: CrmTaskDto['status']
  reminderAt?: number
  sourceMessageId?: string
}

export interface CrmCatalogItemDto {
  id: string
  type: 'product' | 'service'
  name: string
  sku?: string
  description?: string
  unitPrice: number
  currency: string
  active: boolean
  createdAt: number
  updatedAt: number
}

export type CrmOrderStatus = 'draft' | 'confirmed' | 'in-progress' | 'completed' | 'cancelled'
export type CrmPaymentStatus = 'unpaid' | 'partial' | 'paid' | 'refunded'

export interface CrmOrderItemDto {
  id: string
  catalogItemId?: string
  type: 'product' | 'service'
  name: string
  sku?: string
  quantity: number
  unitPrice: number
  discount: number
  taxRate: number
  lineTotal: number
}

export interface CrmPaymentDto {
  id: string
  amount: number
  method?: string
  reference?: string
  paidAt: number
  note?: string
}

export interface CrmOrderDto {
  id: string
  contactId: string
  orderNumber: string
  status: CrmOrderStatus
  paymentStatus: CrmPaymentStatus
  currency: string
  subtotal: number
  discount: number
  tax: number
  total: number
  paidAmount: number
  balanceAmount: number
  shippingAddress?: string
  appointmentAt?: number
  expectedAt?: number
  customerNote?: string
  internalNote?: string
  items: CrmOrderItemDto[]
  payments: CrmPaymentDto[]
  createdAt: number
  updatedAt: number
  completedAt?: number
}

export interface CrmActivityDto {
  id: string
  contactId: string
  type: 'lead-created' | 'stage-changed' | 'lifecycle-changed' | 'note-added' | 'note-updated' | 'task-created' | 'task-updated' | 'task-completed' | 'order-created' | 'order-updated'
  summary: string
  metadata?: Record<string, unknown>
  createdAt: number
}

export interface CrmContactPatch {
  name?: string
  email?: string
  company?: string
  address?: string
  birthday?: string
  taxId?: string
  preferences?: string
  source?: string
  consentStatus?: CrmContactDetailsDto['consentStatus']
  doNotContact?: boolean
  customFields?: Record<string, string>
  tags?: Array<{ name: string; color?: string }>
}

export interface CrmOrderInput {
  id?: string
  contactId: string
  status: CrmOrderStatus
  currency?: string
  shippingAddress?: string
  appointmentAt?: number
  expectedAt?: number
  customerNote?: string
  internalNote?: string
  items: Array<Omit<CrmOrderItemDto, 'id' | 'lineTotal'>>
  payments?: Array<Omit<CrmPaymentDto, 'id'>>
}

export interface AppSettings {
  theme: 'system' | 'light' | 'dark' | 'black' | 'salesforce-black'
  density: 'comfortable' | 'compact' | 'dense' | 'ultra-dense'
  notificationPreview: boolean
  enterToSend: boolean
  showChatPreviews: boolean
  reduceMotion: boolean
  conversationBackground: 'subtle' | 'plain' | 'grid'
  cacheLimitBytes: number
  launchAtLogin: boolean
  historySyncDays: number
  navigationMode: 'auto' | 'expanded' | 'collapsed'
}

export type AppErrorCode =
  | 'OFFLINE'
  | 'NOT_LINKED'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'UNSUPPORTED'
  | 'MEDIA_EXPIRED'
  | 'AUTH_LOST'
  | 'SECURE_STORAGE_UNAVAILABLE'
  | 'CONTACT_RESTRICTED'
  | 'INTERNAL'

export interface AppError {
  code: AppErrorCode
  message: string
  retryable: boolean
}

export interface DiagnosticsDto {
  appVersion: string
  electronVersion: string
  nodeVersion: string
  sessionPhase: SessionPhase
  databaseBytes: number
  mediaCacheBytes: number
  logDirectory: string
  identityCoverage: {
    directChats: number
    resolvedNames: number
    resolvedPhones: number
    savedNames: number
    profileNames: number
    cachedAvatars: number
    failedAvatarRequests: number
  }
}

export interface LogEntryDto {
  timestamp: number
  level: 'warning' | 'error' | 'fatal'
  message: string
  context?: string
}

export interface WarishApi {
  session: {
    getState(): Promise<SessionState>
    startQr(): Promise<SessionState>
    requestPairingCode(phoneNumber: string): Promise<SessionState>
    reconnect(): Promise<SessionState>
    prepareRelink(): Promise<SessionState>
    logout(eraseLocalData: boolean): Promise<void>
  }
  chats: {
    list(input?: { cursor?: string; limit?: number; archived?: boolean; query?: string; category?: ChatCategory;
      crmStage?: ChatCrmStageFilter }): Promise<Page<ChatSummary>>
    get(chatId: string): Promise<ChatSummary>
    getMany(chatIds: string[]): Promise<ChatSummary[]>
    update(chatId: string, patch: Partial<Pick<ChatSummary, 'archived' | 'pinned' | 'mutedUntil'>>): Promise<void>
    markRead(chatId: string): Promise<void>
  }
  contacts: {
    get(chatId: string): Promise<ContactDetails>
    save(chatId: string, input: { fullName: string }): Promise<ContactDetails>
    hydrate(chatIds: string[]): Promise<void>
    refresh(): Promise<ContactSyncState>
    getSyncState(): Promise<ContactSyncState>
  }
  communities: {
    list(input?: { cursor?: string; limit?: number; query?: string }): Promise<Page<CommunitySummary>>
  }
  messages: {
    list(chatId: string, before?: string, limit?: number): Promise<Page<MessageDto>>
    context(chatId: string, messageId: string, radius?: number): Promise<MessageContextDto>
    loadEarlier(chatId: string): Promise<OlderHistoryResult>
    send(input: {
      chatId: string
      clientId: string
      text?: string
      attachmentToken?: string
      attachmentKind?: 'image' | 'video' | 'document' | 'audio' | 'voice' | 'sticker'
      quotedMessageId?: string
      restrictedContactAcknowledged?: boolean
    }): Promise<MessageDto>
    retry(messageId: string): Promise<MessageDto>
    react(chatId: string, messageId: string, emoji?: string): Promise<void>
    edit(chatId: string, messageId: string, text: string): Promise<void>
    delete(chatId: string, messageId: string, mode: 'for-me' | 'for-everyone'): Promise<void>
    forward(messageId: string, chatIds: string[], restrictedContactAcknowledgements?: string[]): Promise<void>
  }
  media: {
    pick(): Promise<PickedAttachment | null>
    saveClipboardImage(data: Uint8Array, mimeType: string): Promise<PickedAttachment>
    saveRecording(data: Uint8Array, mimeType: string): Promise<PickedAttachment>
    thumbnail(messageId: string): Promise<{ thumbnailDataUrl?: string }>
    download(messageId: string): Promise<{ cacheToken: string; url: string }>
    cancel(messageId: string): Promise<void>
    open(cacheToken: string): Promise<void>
    clearCache(): Promise<void>
    discardDraft(token: string): Promise<void>
  }
  crm: {
    dashboard(): Promise<CrmDashboardDto>
    pipeline(): Promise<CrmStageDto[]>
    contacts: {
      list(input?: { lifecycle?: CrmLifecycle | 'active'; stageId?: string; query?: string; limit?: number }): Promise<CrmContactSummaryDto[]>
      get(input: { contactId?: string; chatId?: string }): Promise<CrmContactDetailsDto>
      ensure(chatId: string): Promise<CrmContactDetailsDto>
      update(contactId: string, patch: CrmContactPatch): Promise<CrmContactDetailsDto>
      setStage(contactId: string, stageId: string): Promise<CrmContactDetailsDto>
      setLifecycle(contactId: string, lifecycle: CrmLifecycle): Promise<CrmContactDetailsDto>
    }
    notes: {
      list(contactId: string): Promise<CrmNoteDto[]>
      add(contactId: string, body: string, sourceMessageId?: string): Promise<CrmNoteDto>
      save(input: CrmNoteInput): Promise<CrmNoteDto>
      delete(noteId: string): Promise<void>
    }
    tasks: {
      list(input?: { contactId?: string; status?: CrmTaskDto['status']; due?: 'overdue' | 'today' | 'upcoming' }): Promise<CrmTaskDto[]>
      save(input: CrmTaskInput): Promise<CrmTaskDto>
      delete(taskId: string): Promise<void>
    }
    catalog: {
      list(query?: string, includeInactive?: boolean): Promise<CrmCatalogItemDto[]>
      save(input: Partial<CrmCatalogItemDto> & Pick<CrmCatalogItemDto, 'type' | 'name' | 'unitPrice'>): Promise<CrmCatalogItemDto>
      delete(itemId: string): Promise<void>
    }
    orders: {
      list(contactId?: string): Promise<CrmOrderDto[]>
      get(orderId: string): Promise<CrmOrderDto>
      save(input: CrmOrderInput): Promise<CrmOrderDto>
      delete(orderId: string): Promise<void>
    }
    activity(contactId: string, limit?: number): Promise<CrmActivityDto[]>
  }
  search: {
    messages(query: string, chatId?: string, cursor?: string): Promise<Page<MessageDto>>
  }
  settings: {
    get(): Promise<AppSettings>
    update(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  drafts: {
    get(chatId: string): Promise<DraftDto | undefined>
    save(draft: DraftDto): Promise<void>
    clear(chatId: string): Promise<void>
  }
  diagnostics: {
    get(): Promise<DiagnosticsDto>
    logs(limit?: number): Promise<LogEntryDto[]>
    reportRendererError(message: string, context?: string): Promise<void>
  }
  application: {
    resetLocalData(): Promise<void>
  }
  onEvent(handler: (event: CoreEventEnvelope) => void): () => void
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  density: 'dense',
  notificationPreview: true,
  enterToSend: true,
  showChatPreviews: true,
  reduceMotion: false,
  conversationBackground: 'subtle',
  cacheLimitBytes: 5 * 1024 * 1024 * 1024,
  launchAtLogin: false,
  historySyncDays: 7,
  navigationMode: 'auto'
}
