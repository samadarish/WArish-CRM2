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
  'chat.update',
  'chat.markRead',
  'contacts.get',
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
  unreadCount: number
  archived: boolean
  pinned: boolean
  mutedUntil?: number
  typing?: boolean
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

export interface AppSettings {
  theme: 'system' | 'light' | 'dark' | 'black'
  density: 'comfortable' | 'compact'
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
    list(input?: { cursor?: string; limit?: number; archived?: boolean; query?: string; category?: ChatCategory }): Promise<Page<ChatSummary>>
    get(chatId: string): Promise<ChatSummary>
    update(chatId: string, patch: Partial<Pick<ChatSummary, 'archived' | 'pinned' | 'mutedUntil'>>): Promise<void>
    markRead(chatId: string): Promise<void>
  }
  contacts: {
    get(chatId: string): Promise<ContactDetails>
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
    }): Promise<MessageDto>
    retry(messageId: string): Promise<MessageDto>
    react(chatId: string, messageId: string, emoji?: string): Promise<void>
    edit(chatId: string, messageId: string, text: string): Promise<void>
    delete(chatId: string, messageId: string, mode: 'for-me' | 'for-everyone'): Promise<void>
    forward(messageId: string, chatIds: string[]): Promise<void>
  }
  media: {
    pick(): Promise<PickedAttachment | null>
    saveRecording(data: Uint8Array, mimeType: string): Promise<PickedAttachment>
    thumbnail(messageId: string): Promise<{ thumbnailDataUrl?: string }>
    download(messageId: string): Promise<{ cacheToken: string; url: string }>
    cancel(messageId: string): Promise<void>
    open(cacheToken: string): Promise<void>
    clearCache(): Promise<void>
    discardDraft(token: string): Promise<void>
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
  density: 'compact',
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
