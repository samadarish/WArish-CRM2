import { Component, lazy, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react'
import { useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query'
import type { AppSettings, ChatMergedEvent, ContactSyncState, CoreEventEnvelope, HistoryBatchEvent, MessageDto, Page, SessionState } from '../../shared/contracts'
import { ChatShell } from './components/ChatShell'
import { Onboarding } from './components/Onboarding'
import { resolveSessionSurface } from './session-surface'
import { useUiStore } from './store'
import { destinationForChat } from './workspace-navigation'

const SettingsPanel = lazy(async () => {
  const module = await import('./components/SettingsPanel')
  return { default: module.SettingsPanel }
})

export function App(): React.JSX.Element {
  const queryClient = useQueryClient()
  const settingsOpen = useUiStore((state) => state.settingsOpen)
  const notices = useUiStore((state) => state.notices)
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
      {settingsOpen && <Suspense fallback={<div className="modal-backdrop settings-backdrop"><div className="settings-loading"><div className="spinner" /><span>Opening settings…</span></div></div>}><SettingsPanel /></Suspense>}
      <ToastRegion notices={notices} />
    </div>
  )
}

function handleEvent(event: CoreEventEnvelope, queryClient: ReturnType<typeof useQueryClient>): void {
  if (event.type === 'session.changed') queryClient.setQueryData(['session'], event.payload as SessionState)
  if (event.type === 'settings.changed') queryClient.setQueryData(['settings'], event.payload as AppSettings)
  if (event.type === 'chat.changed') {
    const payload = event.payload as { chatId?: string }
    if (payload.chatId) void queryClient.invalidateQueries({ queryKey: ['chat', payload.chatId] })
    scheduleChatRefresh(queryClient)
  }
  if (event.type === 'contact.changed') {
    const payload = event.payload as { chatIds: string[]; bulk?: boolean }
    for (const chatId of payload.chatIds) {
      void queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
      void queryClient.invalidateQueries({ queryKey: ['contact', chatId] })
    }
    scheduleChatRefresh(queryClient)
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
      scheduleChatRefresh(queryClient)
    }).catch(() => {
      useUiStore.getState().openChat(chatId, 'all')
      scheduleChatRefresh(queryClient)
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
    void queryClient.invalidateQueries({ queryKey: ['crm'] })
  }
  if (event.type === 'history.batch') {
    const batch = event.payload as HistoryBatchEvent
    const affectedChats = new Set(batch.chatIds)
    scheduleChatRefresh(queryClient)
    for (const chatId of affectedChats) void refreshLatestMessagePage(queryClient, chatId)
  }
  if (event.type === 'message.upserted') {
    const message = event.payload as MessageDto
    patchMessage(queryClient, message)
    scheduleChatRefresh(queryClient)
  }
  if (event.type === 'message.changed') {
    const payload = event.payload as { message: MessageDto; replacedId?: string }
    patchMessage(queryClient, payload.message, payload.replacedId)
    scheduleChatRefresh(queryClient)
  }
  if (event.type === 'message.batch') {
    const payload = event.payload as { messages: MessageDto[] }
    for (const message of payload.messages) patchMessage(queryClient, message)
    scheduleChatRefresh(queryClient)
  }
  if (event.type === 'message.statusChanged') {
    const payload = event.payload as { chatId: string; messageId: string; status: MessageDto['status'] }
    patchMessageStatus(queryClient, payload.chatId, payload.messageId, payload.status)
  }
  if (event.type === 'crm.changed') {
    const payload = event.payload
    void queryClient.invalidateQueries({ queryKey: ['crm'] })
    if (payload.contactId) void queryClient.invalidateQueries({ queryKey: ['crm', 'contact', payload.contactId] })
    if (payload.chatId) {
      void queryClient.invalidateQueries({ queryKey: ['chat', payload.chatId] })
      void queryClient.invalidateQueries({ queryKey: ['crm', 'contact', 'chat', payload.chatId] })
    }
    scheduleChatRefresh(queryClient)
  }
  if (event.type === 'crm.taskDue') {
    void queryClient.invalidateQueries({ queryKey: ['crm', 'tasks'] })
    void queryClient.invalidateQueries({ queryKey: ['crm', 'dashboard'] })
    useUiStore.getState().pushNotice(`Follow-up due: ${event.payload.title}`, 'info')
  }
  if (event.type === 'google.statusChanged') queryClient.setQueryData(['google', 'status'], event.payload)
}

let chatRefreshTimer: number | undefined
function scheduleChatRefresh(queryClient: QueryClient): void {
  if (chatRefreshTimer !== undefined) return
  chatRefreshTimer = window.setTimeout(() => {
    chatRefreshTimer = undefined
    void queryClient.invalidateQueries({ queryKey: ['chats'], refetchType: 'active' })
    void queryClient.invalidateQueries({ queryKey: ['communities'], refetchType: 'active' })
  }, 120)
}

type MessagePages = InfiniteData<Page<MessageDto>, string | undefined>
function patchMessage(queryClient: QueryClient, message: MessageDto, replacedId?: string): void {
  queryClient.setQueryData<MessagePages>(['messages', message.chatId], (current) => {
    if (!current?.pages.length) return current
    let found = false
    const pages = current.pages.map((page) => ({ ...page, items: page.items.flatMap((item) => {
      if (item.id === replacedId) return []
      if (item.id !== message.id) return [item]
      found = true
      return [message]
    }) }))
    if (!found) pages[0] = { ...pages[0]!, items: [...pages[0]!.items, message].sort(compareMessages) }
    return { ...current, pages }
  })
}

function patchMessageStatus(queryClient: QueryClient, chatId: string, messageId: string, status: MessageDto['status']): void {
  queryClient.setQueryData<MessagePages>(['messages', chatId], (current) => current ? ({ ...current,
    pages: current.pages.map((page) => ({ ...page,
      items: page.items.map((message) => message.id === messageId ? { ...message, status } : message) }))
  }) : current)
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

function ToastRegion({ notices }: { notices: Array<{ id: number; message: string; tone: 'error' | 'info' }> }): React.JSX.Element {
  const dismiss = useUiStore((state) => state.dismissNotice)
  return <div className="toast-region" aria-live="polite">{notices.map((notice) =>
    <Toast key={notice.id} notice={notice} dismiss={dismiss} />
  )}</div>
}

function Toast({ notice, dismiss }: { notice: { id: number; message: string; tone: 'error' | 'info' }; dismiss(id: number): void }): React.JSX.Element {
  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(notice.id), 5_000)
    return () => window.clearTimeout(timer)
  }, [dismiss, notice.id])
  return <button role={notice.tone === 'error' ? 'alert' : 'status'} className={`toast ${notice.tone}`}
    onClick={() => dismiss(notice.id)}>{notice.message}</button>
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
  document.documentElement.dataset.density = settings.density
  document.documentElement.dataset.navigation = settings.navigationMode
  document.documentElement.dataset.motion = settings.reduceMotion ? 'reduced' : 'system'
  document.documentElement.dataset.conversationBackground = settings.conversationBackground
}

function Splash({ label }: { label: string }): React.JSX.Element {
  return <main className="splash"><div className="brand-mark">W</div><div className="spinner" /><p>{label}</p></main>
}

function FatalError({ error, onRetry }: { error: Error; onRetry(): void }): React.JSX.Element {
  return <main className="splash"><div className="brand-mark error">!</div><h1>WArish could not start</h1><p>{error.message}</p><button onClick={onRetry}>Try again</button></main>
}
