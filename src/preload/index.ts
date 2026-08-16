import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings, ChatSummary, CommunitySummary, ContactDetails, ContactSyncState, CoreEventEnvelope, CrmActivityDto,
  CrmCatalogItemDto, CrmContactDetailsDto, CrmContactSummaryDto, CrmDashboardDto, CrmNoteDto, CrmOrderDto,
  CrmStageDto, CrmTaskDto, DiagnosticsDto, DraftDto, LogEntryDto,
  MessageContextDto, MessageDto, OlderHistoryResult, Page, PickedAttachment, SessionState, WarishApi
} from '../shared/contracts'

const invoke = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
  ipcRenderer.invoke('warish:rpc', { method, params }) as Promise<T>

const api: WarishApi = {
  session: {
    getState: () => invoke<SessionState>('session.getState'),
    startQr: () => invoke<SessionState>('session.startQr'),
    requestPairingCode: (phoneNumber) => invoke<SessionState>('session.requestPairingCode', { phoneNumber }),
    reconnect: () => invoke<SessionState>('session.reconnect'),
    prepareRelink: () => invoke<SessionState>('session.prepareRelink'),
    logout: (eraseLocalData) => invoke<void>('session.logout', { eraseLocalData })
  },
  chats: {
    list: (input = {}) => invoke<Page<ChatSummary>>('chat.list', input),
    get: (chatId) => invoke<ChatSummary>('chat.get', { chatId }),
    getMany: (chatIds) => invoke<ChatSummary[]>('chat.getMany', { chatIds }),
    update: (chatId, patch) => invoke<void>('chat.update', { chatId, patch }),
    markRead: (chatId) => invoke<void>('chat.markRead', { chatId })
  },
  contacts: {
    get: (chatId) => invoke<ContactDetails>('contacts.get', { chatId }),
    save: (chatId, input) => invoke<ContactDetails>('contacts.save', { chatId, input }),
    hydrate: (chatIds) => invoke<void>('contacts.hydrate', { chatIds }),
    refresh: () => invoke<ContactSyncState>('contacts.refresh'),
    getSyncState: () => invoke<ContactSyncState>('contacts.getSyncState')
  },
  communities: {
    list: (input = {}) => invoke<Page<CommunitySummary>>('community.list', input)
  },
  messages: {
    list: (chatId, before, limit) => invoke<Page<MessageDto>>('message.list', { chatId, before, limit }),
    context: (chatId, messageId, radius) => invoke<MessageContextDto>('message.context', { chatId, messageId, radius }),
    loadEarlier: (chatId) => invoke<OlderHistoryResult>('message.loadEarlier', { chatId }),
    send: (input) => invoke<MessageDto>('message.send', { input }),
    sendAlbum: (input) => invoke<MessageDto[]>('message.sendAlbum', { input }),
    retry: (messageId) => invoke<MessageDto>('message.retry', { messageId }),
    react: (chatId, messageId, emoji) => invoke<void>('message.react', { chatId, messageId, emoji }),
    edit: (chatId, messageId, text) => invoke<void>('message.edit', { chatId, messageId, text }),
    delete: (chatId, messageId, mode) => invoke<void>('message.delete', { chatId, messageId, mode }),
    forward: (messageId, chatIds, restrictedContactAcknowledgements) => invoke<void>('message.forward', {
      messageId, chatIds, restrictedContactAcknowledgements
    })
  },
  media: {
    pick: (maxFiles) => ipcRenderer.invoke('warish:pick-attachment', maxFiles) as Promise<PickedAttachment[] | null>,
    saveClipboardImage: (data, mimeType) => ipcRenderer.invoke('warish:save-clipboard-image', data, mimeType) as Promise<PickedAttachment>,
    saveRecording: (data, mimeType) => ipcRenderer.invoke('warish:save-recording', data, mimeType) as Promise<PickedAttachment>,
    thumbnail: (messageId) => invoke<{ thumbnailDataUrl?: string }>('media.thumbnail', { messageId }),
    download: (messageId) => invoke<{ cacheToken: string; url: string }>('media.download', { messageId }),
    cancel: (messageId) => invoke<void>('media.cancel', { messageId }),
    open: (cacheToken) => ipcRenderer.invoke('warish:open-media', cacheToken) as Promise<void>,
    clearCache: () => invoke<void>('media.clearCache'),
    discardDraft: (token) => invoke<void>('media.discardDraft', { token })
  },
  crm: {
    dashboard: () => invoke<CrmDashboardDto>('crm.dashboard.get'),
    pipeline: () => invoke<CrmStageDto[]>('crm.pipeline.get'),
    contacts: {
      list: (input = {}) => invoke<CrmContactSummaryDto[]>('crm.contacts.list', { input }),
      get: (input) => invoke<CrmContactDetailsDto>('crm.contacts.get', input),
      ensure: (chatId) => invoke<CrmContactDetailsDto>('crm.contacts.ensure', { chatId }),
      update: (contactId, patch) => invoke<CrmContactDetailsDto>('crm.contacts.update', { contactId, patch }),
      setStage: (contactId, stageId) => invoke<CrmContactDetailsDto>('crm.contacts.setStage', { contactId, stageId }),
      setLifecycle: (contactId, lifecycle) => invoke<CrmContactDetailsDto>('crm.contacts.setLifecycle', { contactId, lifecycle })
    },
    notes: {
      list: (contactId) => invoke<CrmNoteDto[]>('crm.notes.list', { contactId }),
      add: (contactId, body, sourceMessageId) => invoke<CrmNoteDto>('crm.notes.add', { contactId, body, sourceMessageId }),
      save: (input) => invoke<CrmNoteDto>('crm.notes.save', { input }),
      delete: (noteId) => invoke<void>('crm.notes.delete', { noteId })
    },
    tasks: {
      list: (input = {}) => invoke<CrmTaskDto[]>('crm.tasks.list', { input }),
      save: (input) => invoke<CrmTaskDto>('crm.tasks.save', { input }),
      delete: (taskId) => invoke<void>('crm.tasks.delete', { taskId })
    },
    catalog: {
      list: (query, includeInactive) => invoke<CrmCatalogItemDto[]>('crm.catalog.list', { query, includeInactive }),
      save: (input) => invoke<CrmCatalogItemDto>('crm.catalog.save', { input }),
      delete: (itemId) => invoke<void>('crm.catalog.delete', { itemId })
    },
    orders: {
      list: (contactId) => invoke<CrmOrderDto[]>('crm.orders.list', { contactId }),
      get: (orderId) => invoke<CrmOrderDto>('crm.orders.get', { orderId }),
      save: (input) => invoke<CrmOrderDto>('crm.orders.save', { input }),
      delete: (orderId) => invoke<void>('crm.orders.delete', { orderId })
    },
    activity: (contactId, limit) => invoke<CrmActivityDto[]>('crm.activity.list', { contactId, limit })
  },
  search: { messages: (query, chatId, cursor) => invoke<Page<MessageDto>>('search.messages', { query, chatId, cursor }) },
  settings: {
    get: () => invoke<AppSettings>('settings.get'),
    update: (patch) => invoke<AppSettings>('settings.update', { patch })
  },
  drafts: {
    get: (chatId) => invoke<DraftDto | undefined>('draft.get', { chatId }),
    save: (draft) => invoke<void>('draft.save', { draft }),
    clear: (chatId) => invoke<void>('draft.clear', { chatId })
  },
  diagnostics: {
    get: () => invoke<DiagnosticsDto>('diagnostics.get'),
    logs: (limit) => invoke<LogEntryDto[]>('diagnostics.logs', { limit }),
    reportRendererError: (message, context) => invoke<void>('diagnostics.reportRendererError', { message, context })
  },
  application: {
    resetLocalData: () => ipcRenderer.invoke('warish:reset-local-data') as Promise<void>
  },
  onEvent: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, value: CoreEventEnvelope): void => handler(value)
    ipcRenderer.on('warish:event', listener)
    return () => ipcRenderer.removeListener('warish:event', listener)
  }
}

contextBridge.exposeInMainWorld('warish', api)
