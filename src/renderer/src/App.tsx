import { Component, lazy, memo, Suspense, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query'
import type { AppSettings, ChatMergedEvent, ChatSummary, CommunitySummary, ContactSyncState, CoreEventEnvelope, CoreEventPayloadMap, HistoryBatchEvent, MessageDto, Page, SessionState } from '../../shared/contracts'
import { ChatShell } from './components/ChatShell'
import { Onboarding } from './components/Onboarding'
import { resolveSessionSurface } from './session-surface'
import { MotionPresence } from './motion'
import { motionDuration } from './motion-preference'
import { useUiStore } from './store'
import { destinationForChat } from './workspace-navigation'

const SettingsPanel = lazy(async () => {
  const module = await import('./components/SettingsPanel')
  return { default: module.SettingsPanel }
})

export function App(): React.JSX.Element {
  const queryClient = useQueryClient()
  const settingsOpen = useUiStore((state) => state.settingsOpen)
  const sessionQuery = useQuery({ queryKey: ['session'], queryFn: () => window.warish.session.getState(), retry: false })
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: () => window.warish.settings.get() })

  useEffect(() => window.warish.onEvent((event) => handleEvent(event, queryClient)), [queryClient])
  useEffect(() => {
    const reportError = (event: ErrorEvent): void => {
      void window.warish.diagnostics.reportRendererError(event.message, event.error instanceof Error ? event.error.stack : undefined)
    }
    const reportRejection = (event: PromiseRejectionEvent): void => {
      const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason))
      void window.warish.diagnostics.reportRendererError(error.message, error.stack)
    }
    window.addEventListener('error', reportError)
    window.addEventListener('unhandledrejection', reportRejection)
    return () => {
      window.removeEventListener('error', reportError)
      window.removeEventListener('unhandledrejection', reportRejection)
    }
  }, [])
  useEffect(() => {
    const settings = settingsQuery.data
    applyAppearance(settings)
    if (!settings || settings.theme !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (): void => applyAppearance(settings)
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [settingsQuery.data])

  if (sessionQuery.isLoading) return <Splash label="Starting secure messaging core…" />
  if (sessionQuery.isError) return <FatalError error={sessionQuery.error} onRetry={() => void sessionQuery.refetch()} />

  const session = sessionQuery.data!
  const needsOnboarding = resolveSessionSurface(session) === 'onboarding'
  return (
    <div className="app-root">
      <AppErrorBoundary>{needsOnboarding ? <Onboarding session={session} /> : <ChatShell session={session} />}</AppErrorBoundary>
      <MotionPresence show={settingsOpen}><Suspense fallback={<div className="modal-backdrop settings-backdrop"><div className="settings-loading"><div className="spinner" /><span>Opening settings…</span></div></div>}><SettingsPanel /></Suspense></MotionPresence>
      <ToastRegion />
    </div>
  )
}

function handleEvent(event: CoreEventEnvelope, queryClient: ReturnType<typeof useQueryClient>): void {
  if (event.type === 'session.changed') queryClient.setQueryData(['session'], event.payload as SessionState)
  if (event.type === 'settings.changed') queryClient.setQueryData(['settings'], event.payload as AppSettings)
  if (event.type === 'chat.changed') {
    const payload = event.payload as { chatId?: string }
    if (payload.chatId) void queryClient.invalidateQueries({ queryKey: ['chat', payload.chatId] })
    scheduleChatRefresh(queryClient, payload.chatId ? [payload.chatId] : undefined)
  }
  if (event.type === 'contact.changed') {
    const payload = event.payload as { chatIds: string[]; bulk?: boolean }
    for (const chatId of payload.chatIds) {
      void queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
      void queryClient.invalidateQueries({ queryKey: ['contact', chatId] })
    }
    scheduleChatRefresh(queryClient, payload.chatIds)
  }
  if (event.type === 'contact.syncChanged') {
    queryClient.setQueryData(['contact-sync'], event.payload as ContactSyncState)
  }
  if (event.type === 'navigation.openChat' && event.payload && typeof event.payload === 'object' && 'chatId' in event.payload) {
    const chatId = String(event.payload.chatId)
    useUiStore.getState().selectChat()
    void window.warish.chats.get(chatId).then((chat) => {
      queryClient.setQueryData(['chat', chatId], chat)
      useUiStore.getState().openChat(chatId, destinationForChat(chat))
      scheduleChatRefresh(queryClient, [chatId])
    }).catch(() => {
      useUiStore.getState().openChat(chatId, 'all')
      scheduleChatRefresh(queryClient, [chatId])
    })
  }
  if (event.type === 'navigation.openCrm') useUiStore.getState().openCrmContact(event.payload.contactId)
  if (event.type === 'chat.merged') {
    const merge = event.payload as ChatMergedEvent
    const state = useUiStore.getState()
    if (state.selectedChatId && merge.mergedChatIds.includes(state.selectedChatId)) state.selectChat(merge.chatId)
    scheduleChatRefresh(queryClient)
    for (const chatId of merge.mergedChatIds) queryClient.removeQueries({ queryKey: ['messages', chatId] })
    void queryClient.invalidateQueries({ queryKey: ['messages', merge.chatId] })
    void queryClient.invalidateQueries({ queryKey: ['crm', 'contacts'] })
    void queryClient.invalidateQueries({ queryKey: ['crm', 'dashboard'] })
    void queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] === 'crm' && query.queryKey[1] === 'contact'
    })
  }
  if (event.type === 'history.batch') {
    const batch = event.payload as HistoryBatchEvent
    const affectedChats = new Set(batch.chatIds)
    scheduleChatRefresh(queryClient, batch.chatIds)
    for (const chatId of affectedChats) void refreshLatestMessagePage(queryClient, chatId)
  }
  if (event.type === 'message.upserted') {
    const message = event.payload as MessageDto
    patchMessage(queryClient, message)
    scheduleChatRefresh(queryClient, [message.chatId])
  }
  if (event.type === 'message.changed') {
    const payload = event.payload as { message: MessageDto; replacedId?: string }
    patchMessage(queryClient, payload.message, payload.replacedId)
    scheduleChatRefresh(queryClient, [payload.message.chatId])
  }
  if (event.type === 'message.batch') {
    const payload = event.payload as { messages: MessageDto[] }
    for (const message of payload.messages) patchMessage(queryClient, message)
    scheduleChatRefresh(queryClient, [...new Set(payload.messages.map((message) => message.chatId))])
  }
  if (event.type === 'message.statusChanged') {
    const payload = event.payload as { chatId: string; messageId: string; status: MessageDto['status'] }
    patchMessageStatus(queryClient, payload.chatId, payload.messageId, payload.status)
  }
  if (event.type === 'crm.changed') {
    const payload = event.payload
    invalidateCrmChange(queryClient, payload)
    if (payload.chatId) {
      void queryClient.invalidateQueries({ queryKey: ['chat', payload.chatId] })
    }
    if (payload.chatId) scheduleChatRefresh(queryClient, [payload.chatId])
    else if (payload.scope === 'all') scheduleChatRefresh(queryClient)
  }
  if (event.type === 'crm.taskDue') {
    void queryClient.invalidateQueries({ queryKey: ['crm', 'tasks'] })
    void queryClient.invalidateQueries({ queryKey: ['crm', 'dashboard'] })
    useUiStore.getState().pushNotice(`Follow-up due: ${event.payload.title}`, 'info')
  }
}

function invalidateCrmChange(queryClient: QueryClient, payload: CoreEventPayloadMap['crm.changed']): void {
  if (payload.scope === 'all') {
    void queryClient.invalidateQueries({ queryKey: ['crm'] })
    return
  }
  const keys: Array<readonly unknown[]> = []
  if (payload.contactId) {
    keys.push(['crm', 'contact', payload.contactId], ['crm', 'activity', payload.contactId])
  }
  if (payload.chatId) keys.push(['crm', 'contact', 'chat', payload.chatId])
  if (payload.scope === 'catalog') keys.push(['crm', 'catalog'])
  if (payload.scope === 'contact') {
    keys.push(['crm', 'contacts'], ['crm', 'dashboard'])
    if (payload.contactId) keys.push(['crm', 'notes', payload.contactId])
  }
  if (payload.scope === 'pipeline') keys.push(['crm', 'contacts'], ['crm', 'dashboard'], ['crm', 'pipeline'])
  if (payload.scope === 'task') keys.push(['crm', 'tasks'], ['crm', 'contacts'], ['crm', 'dashboard'])
  if (payload.scope === 'order') keys.push(['crm', 'orders'], ['crm', 'contacts'], ['crm', 'dashboard'])
  void Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })))
}

let chatRefreshTimer: number | undefined
let fullChatRefreshPending = false
const pendingChatRefreshIds = new Set<string>()
function scheduleChatRefresh(queryClient: QueryClient, chatIds?: string[]): void {
  if (chatIds?.length) for (const chatId of chatIds) pendingChatRefreshIds.add(chatId)
  else fullChatRefreshPending = true
  if (chatRefreshTimer !== undefined) return
  chatRefreshTimer = window.setTimeout(() => { void flushChatRefresh(queryClient) }, 120)
}

async function flushChatRefresh(queryClient: QueryClient): Promise<void> {
  chatRefreshTimer = undefined
  const ids = [...pendingChatRefreshIds]
  pendingChatRefreshIds.clear()
  const refreshAll = fullChatRefreshPending
  fullChatRefreshPending = false
  if (refreshAll || !ids.length) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['chats'], refetchType: 'active' }),
      queryClient.invalidateQueries({ queryKey: ['communities'], refetchType: 'active' })
    ])
    return
  }
  try {
    const chats = await window.warish.chats.getMany(ids)
    for (const chat of chats) patchChatSummary(queryClient, chat)
  } catch {
    await queryClient.invalidateQueries({ queryKey: ['chats'], refetchType: 'active' })
  }
}

function patchChatSummary(queryClient: QueryClient, chat: ChatSummary): void {
  queryClient.setQueryData(['chat', chat.id], chat)
  queryClient.setQueriesData<InfiniteData<Page<ChatSummary>, string | undefined>>({ queryKey: ['chats'] }, (current) => {
    if (!current) return current
    const pageSizes = current.pages.map((page) => page.items.length)
    const items = current.pages.flatMap((page) => page.items)
    const index = items.findIndex((item) => item.id === chat.id)
    if (index < 0) return current
    items[index] = chat
    items.sort(compareChatSummaries)
    let offset = 0
    return { ...current, pages: current.pages.map((page, pageIndex) => {
      const size = pageSizes[pageIndex] ?? 0
      const nextItems = items.slice(offset, offset + size)
      offset += size
      return sameItems(page.items, nextItems) ? page : { ...page, items: nextItems }
    }) }
  })
  queryClient.setQueriesData<InfiniteData<Page<CommunitySummary>, string | undefined>>(
    { queryKey: ['communities'] }, (current) => current ? ({ ...current, pages: current.pages.map((page) => {
      let changed = false
      const items = page.items.map((community) => {
        const index = community.children.findIndex((child) => child.id === chat.id)
        if (index < 0 || community.children[index] === chat) return community
        const children = [...community.children]
        children[index] = chat
        changed = true
        return { ...community, children }
      })
      return changed ? { ...page, items } : page
    }) }) : current
  )
}

function sameItems<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function compareChatSummaries(left: ChatSummary, right: ChatSummary): number {
  return Number(right.pinned) - Number(left.pinned)
    || (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0)
    || right.id.localeCompare(left.id)
}

type MessagePages = InfiniteData<Page<MessageDto>, string | undefined>
function patchMessage(queryClient: QueryClient, message: MessageDto, replacedId?: string): void {
  queryClient.setQueryData<MessagePages>(['messages', message.chatId], (current) => {
    if (!current?.pages.length) return current
    let found = false
    let changed = false
    const pages = current.pages.map((page) => {
      if (!page.items.some((item) => item.id === replacedId || item.id === message.id)) return page
      const items = page.items.flatMap((item) => {
        if (item.id === replacedId) { changed = true; return [] }
        if (item.id !== message.id) return [item]
        found = true
        if (item !== message) changed = true
        return [message]
      })
      return changed ? { ...page, items } : page
    })
    if (!found) {
      pages[0] = { ...pages[0]!, items: [...pages[0]!.items, message].sort(compareMessages) }
      changed = true
    }
    if (!changed) return current
    return { ...current, pages }
  })
}

function patchMessageStatus(queryClient: QueryClient, chatId: string, messageId: string, status: MessageDto['status']): void {
  queryClient.setQueryData<MessagePages>(['messages', chatId], (current) => {
    if (!current) return current
    let changed = false
    const pages = current.pages.map((page) => {
      const index = page.items.findIndex((message) => message.id === messageId && message.status !== status)
      if (index < 0) return page
      const items = [...page.items]
      items[index] = { ...items[index]!, status }
      changed = true
      return { ...page, items }
    })
    return changed ? { ...current, pages } : current
  })
}

async function refreshLatestMessagePage(queryClient: QueryClient, chatId: string): Promise<void> {
  const current = queryClient.getQueryData<MessagePages>(['messages', chatId])
  if (!current?.pages.length) return
  try {
    const latest = await window.warish.messages.list(chatId, undefined, 80)
    queryClient.setQueryData<MessagePages>(['messages', chatId], (value) => value?.pages.length
      ? { ...value, pages: [latest, ...value.pages.slice(1)] }
      : value)
  } catch { /* The active query keeps its last usable page and exposes retry in the conversation. */ }
}

function compareMessages(left: MessageDto, right: MessageDto): number {
  return left.timestamp - right.timestamp || left.id.localeCompare(right.id)
}

function ToastRegion(): React.JSX.Element {
  const notices = useUiStore((state) => state.notices)
  const dismiss = useUiStore((state) => state.dismissNotice)
  return <div className="toast-region" aria-live="polite">{notices.map((notice) =>
    <Toast key={notice.id} notice={notice} dismiss={dismiss} />
  )}</div>
}

function Toast({ notice, dismiss }: { notice: { id: number; message: string; tone: 'error' | 'info' }; dismiss(id: number): void }): React.JSX.Element {
  const [exiting, setExiting] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setExiting(true), 4_800)
    return () => window.clearTimeout(timer)
  }, [])
  useEffect(() => {
    if (!exiting) return
    const timer = window.setTimeout(() => dismiss(notice.id), motionDuration(180))
    return () => window.clearTimeout(timer)
  }, [dismiss, exiting, notice.id])
  return <button role={notice.tone === 'error' ? 'alert' : 'status'} className={`toast ${notice.tone}`}
    data-motion-state={exiting ? 'exiting' : 'entered'} onClick={() => setExiting(true)}>{notice.message}</button>
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error): { error: Error } { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer failure', error, info)
    void window.warish.diagnostics.reportRendererError(error.message, `${error.stack ?? ''}\n${info.componentStack ?? ''}`)
  }
  render(): ReactNode {
    if (this.state.error) return <FatalError error={this.state.error} onRetry={() => this.setState({ error: undefined })} />
    return this.props.children
  }
}

function applyAppearance(settings?: AppSettings): void {
  if (!settings) return
  const theme = settings.theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : settings.theme
  document.documentElement.dataset.theme = theme
  document.documentElement.dataset.density = settings.density === 'ultra-dense' ? 'dense' : settings.density
  document.documentElement.dataset.densityMode = settings.density
  document.documentElement.dataset.navigation = settings.navigationMode
  document.documentElement.dataset.motion = settings.reduceMotion ? 'reduced' : 'system'
  document.documentElement.dataset.conversationBackground = settings.conversationBackground
}

const Splash = memo(function Splash({ label }: { label: string }): React.JSX.Element {
  return <main className="splash"><div className="brand-mark">W</div><div className="spinner" /><p>{label}</p></main>
})

function FatalError({ error, onRetry }: { error: Error; onRetry(): void }): React.JSX.Element {
  return <main className="splash"><div className="brand-mark error">!</div><h1>WArish could not start</h1><p>{error.message}</p><button onClick={onRetry}>Try again</button></main>
}
