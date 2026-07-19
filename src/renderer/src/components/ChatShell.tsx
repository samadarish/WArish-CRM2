import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { format, isSameDay, isToday, isYesterday } from 'date-fns'
import {
  Archive, ArchiveRestore, ArrowDown, ArrowUp, Check, CheckCheck, ChevronDown, ChevronRight,
  CalendarClock, CircleAlert, Link2, ListTodo, LoaderCircle, Menu, MessageCircle, Mic, NotebookPen, Paperclip,
  Pin, PinOff, Radio, RefreshCw, Search, Send, Settings, Smile, Square, WifiOff, X
} from 'lucide-react'
import type { AppSettings, ChatCategory, ChatSummary, CommunitySummary, CrmChatIndicatorDto, CrmContactDetailsDto, CrmTaskDto, DraftDto, MessageDto, Page, PickedAttachment, SessionState } from '../../../shared/contracts'
import { useUiStore } from '../store'
import { shouldSubmitComposer } from '../composer-keyboard'
import { contactIdentityPresentation, type ContactIdentityPresentation } from '../contact-identity'
import { messageGroupPositions } from '../message-grouping'
import { Avatar } from './Avatar'
import { MessageBubble } from './MessageBubble'
import { NavigationRail, type SidebarDestination } from './NavigationRail'

const ContactDrawer = lazy(async () => {
  const module = await import('./ContactDrawer')
  return { default: module.ContactDrawer }
})
const CrmShell = lazy(async () => {
  const module = await import('./CrmShell')
  return { default: module.CrmShell }
})

export function ChatShell({ session }: { session: SessionState }): React.JSX.Element {
  const destination = useUiStore((state) => state.destination)
  const navigate = useUiStore((state) => state.navigate)
  if (destination === 'crm') return <div className="crm-shell-frame"><NavigationRail current={destination} onNavigate={navigate} />
    <Suspense fallback={<div className="crm-state"><LoaderCircle className="spin" />Opening CRM…</div>}><CrmShell /></Suspense></div>
  return <ConversationShell session={session} />
}

function ConversationShell({ session }: { session: SessionState }): React.JSX.Element {
  const [chatQuery, setChatQuery] = useState('')
  const [forwardMessage, setForwardMessage] = useState<MessageDto>()
  const [expandedCommunities, setExpandedCommunities] = useState<Set<string>>(() => new Set())
  const [sidebarMenuOpen, setSidebarMenuOpen] = useState(false)
  const [relinkOpen, setRelinkOpen] = useState(false)
  const debouncedChatQuery = useDebouncedValue(chatQuery, 220)
  const selectedChatId = useUiStore((state) => state.selectedChatId)
  const destination = useUiStore((state) => state.destination)
  const selectChat = useUiStore((state) => state.selectChat)
  const navigate = useUiStore((state) => state.navigate)
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen)
  const pushNotice = useUiStore((state) => state.pushNotice)
  const showArchived = destination === 'archived'
  const category: ChatCategory = showArchived || destination === 'crm' ? 'all' : destination
  const chatListRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: () => window.warish.settings.get() })
  const showChatPreviews = settingsQuery.data?.showChatPreviews ?? true
  const enterToSend = settingsQuery.data?.enterToSend ?? true
  const reconnectMutation = useMutation({
    mutationFn: () => window.warish.session.reconnect(),
    onSuccess: (state) => queryClient.setQueryData(['session'], state),
    onError: (error) => pushNotice(errorMessage(error))
  })
  useEffect(() => { if (session.accountState === 'linked') setRelinkOpen(false) }, [session.accountState])
  const chatsQuery = useInfiniteQuery({
    queryKey: ['chats', showArchived, category, debouncedChatQuery],
    queryFn: ({ pageParam }) => window.warish.chats.list({ cursor: pageParam, limit: 50, archived: showArchived,
      category, query: debouncedChatQuery }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: destination !== 'community'
  })
  const communitiesQuery = useInfiniteQuery({
    queryKey: ['communities', debouncedChatQuery],
    queryFn: ({ pageParam }) => window.warish.communities.list({ cursor: pageParam, limit: 30, query: debouncedChatQuery }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: destination === 'community'
  })
  const chats = useMemo(() => {
    const unique = new Map<string, ChatSummary>()
    for (const chat of chatsQuery.data?.pages.flatMap((page) => page.items) ?? []) unique.set(chat.id, chat)
    return [...unique.values()]
  }, [chatsQuery.data])
  const communities = useMemo(() => {
    const unique = new Map<string, CommunitySummary>()
    for (const community of communitiesQuery.data?.pages.flatMap((page) => page.items) ?? []) unique.set(community.id, community)
    return [...unique.values()]
  }, [communitiesQuery.data])
  const communityItems = useMemo<SidebarItem[]>(() => communities.flatMap((community) => {
    const parent: SidebarItem = { type: 'community', community }
    const expanded = Boolean(debouncedChatQuery.trim()) || expandedCommunities.has(community.id)
    return expanded
      ? [parent, ...community.children.map((chat) => ({ type: 'chat' as const, chat, nested: true }))]
      : [parent]
  }), [communities, debouncedChatQuery, expandedCommunities])
  const sidebarItems = useMemo<SidebarItem[]>(() => destination === 'community'
    ? communityItems
    : chats.map((chat) => ({ type: 'chat' as const, chat })), [chats, communityItems, destination])
  const listedSelectedChat = chats.find((chat) => chat.id === selectedChatId) ??
    communities.flatMap((community) => community.children).find((chat) => chat.id === selectedChatId)
  const selectedChatQuery = useQuery({
    queryKey: ['chat', selectedChatId],
    queryFn: () => window.warish.chats.get(selectedChatId!),
    enabled: Boolean(selectedChatId),
    initialData: listedSelectedChat
  })
  const selectedChat = selectedChatQuery.data ?? listedSelectedChat
  useEffect(() => {
    if (selectedChatId) return
    const first = destination === 'community' ? communities[0]?.children[0] : chats[0]
    if (first) selectChat(first.id)
  }, [chats, communities, destination, selectChat, selectedChatId])
  const listHasNextPage = destination === 'community' ? communitiesQuery.hasNextPage : chatsQuery.hasNextPage
  const listIsFetchingNextPage = destination === 'community' ? communitiesQuery.isFetchingNextPage : chatsQuery.isFetchingNextPage
  const sidebarVirtualizer = useVirtualizer({
    count: sidebarItems.length + (listHasNextPage ? 1 : 0),
    getScrollElement: () => chatListRef.current,
    estimateSize: (index) => {
      const item = sidebarItems[index]
      const crmExtra = item?.type === 'chat' && item.chat.crm ? 18 : 0
      if (document.documentElement.dataset.density === 'compact') {
        const hasIdentity = item?.type === 'chat' ? contactIdentityPresentation(item.chat).hasSecondary : false
        if (item?.type === 'community') return 68
        return (showChatPreviews ? (hasIdentity ? 76 : 64) : (hasIdentity ? 64 : 58)) + crmExtra
      }
      const hasIdentity = item?.type === 'chat' ? contactIdentityPresentation(item.chat).hasSecondary : false
      if (item?.type === 'community') return 78
      if (item?.type === 'chat' && item.nested && !hasIdentity) return (showChatPreviews ? 70 : 64) + crmExtra
      return (showChatPreviews ? (hasIdentity ? 88 : 76) : (hasIdentity ? 72 : 64)) + crmExtra
    },
    getItemKey: (index) => {
      const item = sidebarItems[index]
      return item?.type === 'community' ? `community:${item.community.id}`
        : item?.type === 'chat' ? `chat:${item.chat.id}` : 'chat-loader'
    },
    overscan: 8
  })
  const virtualSidebarItems = sidebarVirtualizer.getVirtualItems()
  useEffect(() => sidebarVirtualizer.measure(), [showChatPreviews, sidebarVirtualizer])
  const lastVirtualItemIndex = virtualSidebarItems.at(-1)?.index
  useEffect(() => {
    if (lastVirtualItemIndex === undefined || lastVirtualItemIndex < sidebarItems.length - 5 || !listHasNextPage || listIsFetchingNextPage) return
    if (destination === 'community') void communitiesQuery.fetchNextPage()
    else void chatsQuery.fetchNextPage()
  }, [chatsQuery, communitiesQuery, destination, lastVirtualItemIndex, listHasNextPage, listIsFetchingNextPage, sidebarItems.length])
  useEffect(() => {
    const element = chatListRef.current
    if (!element || !listHasNextPage || listIsFetchingNextPage || element.scrollHeight > element.clientHeight + 4) return
    if (destination === 'community') void communitiesQuery.fetchNextPage()
    else void chatsQuery.fetchNextPage()
  }, [chatsQuery, communitiesQuery, destination, listHasNextPage, listIsFetchingNextPage, sidebarItems.length])
  const visibleContactIds = useMemo(() => virtualSidebarItems.flatMap((virtualItem) => {
    const item = sidebarItems[virtualItem.index]
    return item?.type === 'chat' ? [item.chat.id] : []
  }), [sidebarItems, virtualSidebarItems])
  const hydrationKey = `${session.phase}:${[...visibleContactIds, selectedChatId ?? ''].join('|')}`
  useEffect(() => {
    const ids = [...new Set([...visibleContactIds, ...(selectedChatId ? [selectedChatId] : [])])]
    if (!ids.length) return
    const timer = window.setTimeout(() => {
      void window.warish.contacts.hydrate(ids).catch(() => undefined)
    }, 80)
    return () => window.clearTimeout(timer)
  // The stable key prevents a new request when the virtualizer returns equivalent item objects.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrationKey])
  const markRead = (chatId: string): void => {
    void window.warish.chats.markRead(chatId).catch((error) => pushNotice(errorMessage(error)))
    queryClient.setQueryData<ChatSummary>(['chat', chatId], (current) => current ? { ...current, unreadCount: 0 } : current)
    queryClient.setQueriesData<InfiniteData<Page<ChatSummary>, string | undefined>>({ queryKey: ['chats'] }, (current) => current ? ({
      ...current, pages: current.pages.map((page) => ({ ...page,
        items: page.items.map((chat) => chat.id === chatId ? { ...chat, unreadCount: 0 } : chat) }))
    }) : current)
    queryClient.setQueriesData<InfiniteData<Page<CommunitySummary>, string | undefined>>({ queryKey: ['communities'] }, (current) => current ? ({
      ...current, pages: current.pages.map((page) => ({ ...page, items: page.items.map((community) => {
        const selected = community.children.find((child) => child.id === chatId)
        return selected ? { ...community, unreadCount: Math.max(0, community.unreadCount - selected.unreadCount),
          children: community.children.map((child) => child.id === chatId ? { ...child, unreadCount: 0 } : child) } : community
      }) }))
    }) : current)
  }
  const changeDestination = (next: SidebarDestination): void => {
    navigate(next)
    setSidebarMenuOpen(false)
    setChatQuery('')
  }
  const toggleCommunity = (communityId: string): void => setExpandedCommunities((current) => {
    const next = new Set(current)
    if (next.has(communityId)) next.delete(communityId)
    else next.add(communityId)
    return next
  })
  useEffect(() => {
    if (chatListRef.current) chatListRef.current.scrollTop = 0
  }, [destination])
  useEffect(() => {
    const closeMenu = (event: KeyboardEvent): void => { if (event.key === 'Escape') setSidebarMenuOpen(false) }
    window.addEventListener('keydown', closeMenu)
    return () => window.removeEventListener('keydown', closeMenu)
  }, [])
  const sidebarPending = destination === 'community' ? communitiesQuery.isPending : chatsQuery.isPending
  const sidebarError = destination === 'community' ? communitiesQuery.isError : chatsQuery.isError

  return (
    <div className="chat-shell">
      <NavigationRail current={destination} onNavigate={changeDestination} />
      <aside className={`chat-list-panel ${showChatPreviews ? '' : 'chat-previews-hidden'}`}>
        <header className="panel-header"><h1>{destinationLabel(destination)}</h1><button className="icon-button" title="Chat list menu" aria-label="Chat list menu" aria-haspopup="menu" aria-expanded={sidebarMenuOpen} onClick={() => setSidebarMenuOpen((open) => !open)}><Menu /></button>
          {sidebarMenuOpen && <><button className="menu-dismiss" aria-label="Close menu" onClick={() => setSidebarMenuOpen(false)} /><div className="header-menu sidebar-header-menu" role="menu">
            <button role="menuitem" onClick={() => changeDestination(showArchived ? 'all' : 'archived')}>{showArchived ? <MessageCircle /> : <Archive />}{showArchived ? 'All conversations' : 'Archived'}</button>
            <button role="menuitem" onClick={() => { setSidebarMenuOpen(false); setSettingsOpen(true) }}><Settings />Settings</button>
          </div></>}
        </header>
        <label className="search-box"><Search /><input value={chatQuery} onChange={(event) => setChatQuery(event.target.value)} placeholder={`Search ${destinationLabel(destination).toLowerCase()}`} />{chatQuery && <button aria-label="Clear chat search" onClick={() => setChatQuery('')}><X /></button>}</label>
        <div className="chat-list" ref={chatListRef}>
          {sidebarPending && <SkeletonRows />}
          {!sidebarPending && !sidebarError && sidebarItems.length === 0 && <EmptyChatList destination={destination} />}
          {sidebarError && <QueryError label={destination === 'community' ? 'Could not load communities' : 'Could not load conversations'}
            onRetry={() => void (destination === 'community' ? communitiesQuery.refetch() : chatsQuery.refetch())} />}
          {!sidebarPending && !sidebarError && <div className="virtual-chat-list" style={{ height: sidebarVirtualizer.getTotalSize() }}>
            {virtualSidebarItems.map((virtualItem) => {
              const item = sidebarItems[virtualItem.index]
              return <div key={String(virtualItem.key)} ref={sidebarVirtualizer.measureElement} data-index={virtualItem.index}
                className="virtual-chat-row" style={{ transform: `translateY(${virtualItem.start}px)` }}>
                {item?.type === 'community' ? <CommunityParentRow community={item.community}
                  expanded={Boolean(debouncedChatQuery.trim()) || expandedCommunities.has(item.community.id)}
                  onToggle={() => toggleCommunity(item.community.id)} />
                  : item?.type === 'chat' ? <ChatRow chat={item.chat} nested={item.nested}
                    active={item.chat.id === selectedChatId} showPreview={showChatPreviews} onClick={() => { selectChat(item.chat.id); markRead(item.chat.id) }} />
                    : <LoadingRow label={destination === 'community' ? 'Loading more communities…' : 'Loading more conversations…'} />}
              </div>
            })}
          </div>}
        </div>
      </aside>
      <main className="conversation-panel">
        {session.phase !== 'connected' && <SessionBanner session={session} retryPending={reconnectMutation.isPending}
          onRetry={() => reconnectMutation.mutate()} onRelink={() => setRelinkOpen(true)} onSettings={() => setSettingsOpen(true)} />}
        {session.phase === 'connected' && session.historySync?.state === 'running' &&
          <div className="connection-banner history-sync-banner"><LoaderCircle className="spin" />Syncing recent history — {Math.round(session.historySync.progress)}%</div>}
        {selectedChatQuery.isError ? <QueryError label="Could not open this conversation" onRetry={() => void selectedChatQuery.refetch()} />
          : selectedChat ? <Conversation key={selectedChat.id} chat={selectedChat} session={session} enterToSend={enterToSend} onForward={setForwardMessage} onChatHidden={() => selectChat()} /> : <WelcomePanel />}
      </main>
      {forwardMessage && <ForwardDialog message={forwardMessage} onClose={() => setForwardMessage(undefined)} />}
      {relinkOpen && <RelinkDialog session={session} onClose={() => setRelinkOpen(false)} />}
    </div>
  )
}

function SessionBanner({ session, retryPending, onRetry, onRelink, onSettings }: {
  session: SessionState; retryPending: boolean; onRetry(): void; onRelink(): void; onSettings(): void
}): React.JSX.Element {
  if (session.accountState === 'relink-required') return <div className="connection-banner session-banner danger" role="alert">
    <CircleAlert /><span><strong>WhatsApp session expired</strong><small>{session.message ?? 'Relink your account to resume messaging. Your local history is still available.'}</small></span>
    <button onClick={onRelink}><Link2 />{session.phase === 'pairing' ? 'Continue relinking' : 'Relink account'}</button>
  </div>
  if (session.phase === 'error') return <div className="connection-banner session-banner danger" role="alert">
    <CircleAlert /><span><strong>WhatsApp could not connect</strong><small>{session.message ?? 'Your local history is still available.'}</small></span>
    <button disabled={retryPending} onClick={onRetry}><RefreshCw className={retryPending ? 'spin' : ''} />Retry</button><button onClick={onSettings}>Settings</button>
  </div>
  if (session.phase === 'offline') return <div className="connection-banner session-banner warning" role="status">
    <WifiOff /><span><strong>WhatsApp is offline</strong><small>{session.message ?? 'WArish will keep trying in the background.'}</small></span>
    <button disabled={retryPending} onClick={onRetry}><RefreshCw className={retryPending ? 'spin' : ''} />Retry now</button>
  </div>
  return <div className="connection-banner session-banner info" role="status"><LoaderCircle className="spin" /><span><strong>Connecting to WhatsApp</strong><small>{session.message ?? 'Your local conversations are ready while the secure connection starts.'}</small></span></div>
}

function RelinkDialog({ session, onClose }: { session: SessionState; onClose(): void }): React.JSX.Element {
  const [phone, setPhone] = useState('')
  const queryClient = useQueryClient()
  const pushNotice = useUiStore((state) => state.pushNotice)
  const qrMutation = useMutation({
    mutationFn: () => window.warish.session.startQr(),
    onSuccess: (state) => queryClient.setQueryData(['session'], state),
    onError: (error) => pushNotice(errorMessage(error))
  })
  const codeMutation = useMutation({
    mutationFn: () => window.warish.session.requestPairingCode(phone),
    onSuccess: (state) => queryClient.setQueryData(['session'], state),
    onError: (error) => pushNotice(errorMessage(error))
  })
  const pending = qrMutation.isPending || codeMutation.isPending
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="modal relink-dialog" role="dialog" aria-modal="true" aria-labelledby="relink-title">
    <header><div><h2 id="relink-title">Relink WhatsApp</h2><p>Your local conversations and preferences will remain unchanged.</p></div><button className="icon-button" aria-label="Close relink dialog" onClick={onClose}><X /></button></header>
    <div className="relink-content">{session.qrDataUrl ? <div className="relink-qr"><img className="qr-code" src={session.qrDataUrl} alt="WhatsApp linked-device QR code" /><div><strong>Scan with your phone</strong><ol><li>Open WhatsApp</li><li>Open Linked devices</li><li>Choose Link a device</li></ol></div></div>
      : session.pairingCode ? <div className="code-view"><strong>{formatPairingCode(session.pairingCode)}</strong><p>Enter this code from WhatsApp → Linked devices → Link a device.</p></div>
        : session.phase === 'pairing' ? <div className="loading-row"><LoaderCircle className="spin" />Preparing a secure pairing code…</div>
          : <><div className="relink-callout"><Link2 /><div><strong>Reconnect this device</strong><span>Choose QR for the quickest setup, or request a phone-number pairing code.</span></div></div>
            <button className="primary-button large" disabled={pending} onClick={() => qrMutation.mutate()}>{qrMutation.isPending ? <LoaderCircle className="spin" /> : <Link2 />}Continue with QR code</button>
            <div className="divider"><span>or use your phone number</span></div>
            <div className="phone-code-row"><input aria-label="International phone number" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="International number, e.g. 15551234567" /><button disabled={!phone.trim() || pending} onClick={() => codeMutation.mutate()}>{codeMutation.isPending ? 'Preparing…' : 'Get code'}</button></div></>}
    </div>
  </section></div>
}

type SidebarItem =
  | { type: 'community'; community: CommunitySummary }
  | { type: 'chat'; chat: ChatSummary; nested?: boolean }

function EmptyChatList({ destination }: { destination: SidebarDestination }): React.JSX.Element {
  const archived = destination === 'archived'
  const label = archived ? 'No archived conversations' : destination === 'community' ? 'No communities found'
    : destination === 'channel' ? 'No channels found' : destination === 'group' ? 'No groups found'
      : destination === 'direct' ? 'No direct chats found' : 'No conversations yet'
  return <div className="empty-list">{archived ? <Archive /> : <MessageCircle />}<p>{label}</p>
    <span>{archived ? 'Archived conversations will appear here.' : 'Items will appear as WhatsApp history and metadata arrive.'}</span></div>
}

function CommunityParentRow({ community, expanded, onToggle }: {
  community: CommunitySummary
  expanded: boolean
  onToggle(): void
}): React.JSX.Element {
  return <button className="community-parent" aria-expanded={expanded} onClick={onToggle}>
      {expanded ? <ChevronDown /> : <ChevronRight />}
      <Avatar title={community.title} src={community.avatarUrl} />
      <span className="community-copy"><span><strong>{community.title}</strong>{community.lastMessageAt && <time>{chatTime(community.lastMessageAt)}</time>}</span>
        <span>{community.children.length} {community.children.length === 1 ? 'group' : 'groups'}{community.unreadCount > 0 && <b>{community.unreadCount > 99 ? '99+' : community.unreadCount}</b>}</span></span>
    </button>
}

function ChatRow({ chat, active, showPreview, nested = false, onClick }: { chat: ChatSummary; active: boolean; showPreview: boolean; nested?: boolean; onClick(): void }): React.JSX.Element {
  const identity = contactIdentityPresentation(chat)
  return <button className={`chat-row ${chat.kind === 'direct' ? 'direct' : ''} ${identity.hasSecondary ? 'has-identity' : ''} ${chat.crm ? 'has-crm' : ''} ${nested ? 'nested' : ''} ${active ? 'active' : ''}`} onClick={onClick}>
    <Avatar title={identity.primary} src={chat.avatarUrl} /><span className="chat-row-copy"><span className="chat-row-top"><strong title={identity.primary}>{identity.primary}</strong>{chat.lastMessageAt && <time>{chatTime(chat.lastMessageAt)}</time>}{!showPreview && chat.unreadCount > 0 && <b>{chat.unreadCount > 99 ? '99+' : chat.unreadCount}</b>}</span>
      {identity.hasSecondary && <ContactIdentityDetails identity={identity} />}
      {chat.crm && <ChatCrmSignal crm={chat.crm} />}
      {showPreview && <span className="chat-row-bottom"><span>{chat.typing ? 'typing…' : chat.lastMessage ?? 'No messages yet'}</span>{chat.unreadCount > 0 && <b>{chat.unreadCount > 99 ? '99+' : chat.unreadCount}</b>}</span>}</span>
  </button>
}

function ChatCrmSignal({ crm }: { crm: CrmChatIndicatorDto }): React.JSX.Element {
  return <span className="chat-crm-signal"><span style={{ '--stage-color': crm.stageColor } as React.CSSProperties}><i />{crm.stageName}</span>
    {crm.nextTask && <span className={crm.nextTask.dueAt && crm.nextTask.dueAt < Date.now() ? 'overdue' : ''}><CalendarClock />{crm.nextTask.dueAt ? compactTaskDate(crm.nextTask.dueAt) : 'Next task'}</span>}</span>
}

function ContactIdentityDetails({ identity, header = false }: { identity: ContactIdentityPresentation; header?: boolean }): React.JSX.Element {
  return <span className={`${header ? 'conversation-contact-identity' : 'chat-row-identity'} contact-identity-details`}>
    {identity.profileName && <span className="whatsapp-profile-pill" title={identity.profileName}>{identity.profileName}</span>}
  </span>
}

function Conversation({ chat, session, enterToSend, onForward, onChatHidden }: {
  chat: ChatSummary
  session: SessionState
  enterToSend: AppSettings['enterToSend']
  onForward(message: MessageDto): void
  onChatHidden(): void
}): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [remoteHistory, setRemoteHistory] = useState<MessageDto[]>([])
  const [remoteHasMore, setRemoteHasMore] = useState(true)
  const [newMessageCount, setNewMessageCount] = useState(0)
  const [messageViewportHeight, setMessageViewportHeight] = useState(0)
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false)
  const [contactDrawerOpen, setContactDrawerOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [messageSearch, setMessageSearch] = useState('')
  const [focusedMessageId, setFocusedMessageId] = useState<string>()
  const [replyTo, setReplyTo] = useState<MessageDto>()
  const [crmCapture, setCrmCapture] = useState<{ kind: 'note' | 'task'; message: MessageDto }>()
  const [attachment, setAttachment] = useState<PickedAttachment>()
  const [attachmentKind, setAttachmentKind] = useState<'image' | 'video' | 'document' | 'audio' | 'voice' | 'sticker'>()
  const recorder = useRef<MediaRecorder | undefined>(undefined)
  const recordingTimer = useRef<number | undefined>(undefined)
  const recordingCancelledRef = useRef(false)
  const focusTimerRef = useRef<number | undefined>(undefined)
  const nearBottomRef = useRef(true)
  const pendingOwnSendRef = useRef(false)
  const activeChatRef = useRef<string | undefined>(undefined)
  const previousMessagesRef = useRef<MessageDto[]>([])
  const anchorRef = useRef<{ id: string; viewportOffset: number } | undefined>(undefined)
  const scrollFrameRef = useRef<number | undefined>(undefined)
  const scrollStateFrameRef = useRef<number | undefined>(undefined)
  const rowResizeFrameRef = useRef<number | undefined>(undefined)
  const activeRef = useRef(true)
  const draftReadyRef = useRef(false)
  const pushNotice = useUiStore((state) => state.pushNotice)
  const queryClient = useQueryClient()
  const debouncedMessageSearch = useDebouncedValue(messageSearch, 220)
  const messageQuery = useInfiniteQuery({
    queryKey: ['messages', chat.id],
    queryFn: ({ pageParam }) => window.warish.messages.list(chat.id, pageParam, 80),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor
  })
  const draftQuery = useQuery({
    queryKey: ['draft', chat.id],
    queryFn: () => window.warish.drafts.get(chat.id),
    staleTime: Infinity,
    enabled: !chat.readOnly
  })
  const messageSearchQuery = useInfiniteQuery({
    queryKey: ['message-search', chat.id, debouncedMessageSearch.trim()],
    queryFn: ({ pageParam }) => window.warish.search.messages(debouncedMessageSearch.trim(), chat.id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: searchOpen && debouncedMessageSearch.trim().length > 0
  })
  const messageSearchResults = useMemo(() => messageSearchQuery.data?.pages.flatMap((page) => page.items) ?? [], [messageSearchQuery.data])
  useEffect(() => {
    if (!draftQuery.isFetched || draftReadyRef.current) return
    const draft = draftQuery.data
    setText(draft?.text ?? '')
    setAttachment(draft?.attachment)
    setAttachmentKind(draft?.attachmentKind)
    draftReadyRef.current = true
  }, [draftQuery.data, draftQuery.isFetched])
  useEffect(() => {
    if (chat.readOnly || !draftReadyRef.current) return
    const timer = window.setTimeout(() => {
      void window.warish.drafts.save({ chatId: chat.id, text, attachment, attachmentKind, updatedAt: Date.now() })
        .catch((error) => pushNotice(errorMessage(error)))
    }, 350)
    return () => window.clearTimeout(timer)
  }, [attachment, attachmentKind, chat.id, chat.readOnly, pushNotice, text])
  const messages = useMemo(() => {
    const unique = new Map<string, MessageDto>()
    const local = [...(messageQuery.data?.pages ?? [])].reverse().flatMap((page) => page.items)
    for (const message of [...remoteHistory, ...local]) unique.set(message.id, message)
    return [...unique.values()].sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
  }, [messageQuery.data, remoteHistory])
  const timeline = useMemo(() => buildTimeline(messages), [messages])
  const groupPositionById = useMemo(() => messageGroupPositions(messages), [messages])
  const showSenderById = useMemo(() => {
    const result = new Map<string, boolean>()
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!
      const position = groupPositionById.get(message.id)
      result.set(message.id, chat.kind === 'group' && !message.fromMe && (position === 'first' || position === 'single'))
    }
    return result
  }, [chat.kind, groupPositionById, messages])
  const virtualizer = useVirtualizer({
    count: timeline.length + 1,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => index === 0 ? 52 : timeline[index - 1]?.type === 'date' ? 38 : 76,
    getItemKey: (index) => index === 0 ? `history-controls:${chat.id}` : timeline[index - 1]?.key ?? `message:${index}`,
    useAnimationFrameWithResizeObserver: true,
    overscan: 12
  })
  const virtualMessageHeight = virtualizer.getTotalSize()
  const virtualMessageOffset = Math.max(0, messageViewportHeight - virtualMessageHeight)
  const captureAnchor = useCallback((): void => {
    const element = parentRef.current
    if (!element) return
    const item = virtualizer.getVirtualItems().find((candidate) => {
      if (candidate.index === 0) return false
      if (timeline[candidate.index - 1]?.type !== 'message') return false
      return candidate.end >= element.scrollTop
    })
    const timelineItem = item ? timeline[item.index - 1] : undefined
    const message = timelineItem?.type === 'message' ? timelineItem.message : undefined
    if (item && message) {
      const row = element.querySelector<HTMLElement>(`[data-index="${item.index}"]`)
      anchorRef.current = {
        id: message.id,
        viewportOffset: row
          ? row.getBoundingClientRect().top - element.getBoundingClientRect().top
          : item.start + virtualMessageOffset - element.scrollTop
      }
    }
  }, [timeline, virtualMessageOffset, virtualizer])
  const measureRenderedRows = useCallback((): void => {
    const element = parentRef.current
    if (!element) return
    for (const row of element.querySelectorAll<HTMLElement>('.virtual-message[data-index]')) {
      virtualizer.measureElement(row)
    }
  }, [virtualizer])
  const restoreAnchor = useCallback((anchor: { id: string; viewportOffset: number }): void => {
    if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = requestAnimationFrame(() => {
      measureRenderedRows()
      const index = timeline.findIndex((item) => item.type === 'message' && item.message.id === anchor.id)
      if (index < 0) {
        scrollFrameRef.current = undefined
        return
      }
      virtualizer.scrollToIndex(index + 1, { align: 'start' })
      scrollFrameRef.current = requestAnimationFrame(() => {
        const element = parentRef.current
        const row = element?.querySelector<HTMLElement>(`[data-index="${index + 1}"]`)
        if (element && row) {
          const currentOffset = row.getBoundingClientRect().top - element.getBoundingClientRect().top
          element.scrollTop += currentOffset - anchor.viewportOffset
        }
        scrollFrameRef.current = undefined
      })
    })
  }, [measureRenderedRows, timeline, virtualizer])
  const scrollToNewest = useCallback((clearNotice = true): void => {
    if (!messages.length) return
    if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(timeline.length, { align: 'end' })
      nearBottomRef.current = true
      if (clearNotice) setNewMessageCount(0)
      scrollFrameRef.current = undefined
    })
  }, [messages.length, timeline.length, virtualizer])
  const handleRowResize = useCallback((): void => {
    if (rowResizeFrameRef.current !== undefined) return
    const shouldFollow = nearBottomRef.current
    const anchor = anchorRef.current
    rowResizeFrameRef.current = requestAnimationFrame(() => {
      rowResizeFrameRef.current = undefined
      measureRenderedRows()
      if (shouldFollow) scrollToNewest(false)
      else if (anchor) restoreAnchor(anchor)
    })
  }, [measureRenderedRows, restoreAnchor, scrollToNewest])
  const sendMutation = useMutation({
    mutationFn: (input: { chatId: string; clientId: string; text?: string; attachmentToken?: string;
      attachmentKind?: 'image' | 'video' | 'document' | 'audio' | 'voice' | 'sticker'; quotedMessageId?: string;
      restrictedContactAcknowledged?: boolean }) =>
      window.warish.messages.send(input),
    onMutate: (input) => {
      pendingOwnSendRef.current = true
      if (input.text === text.trim()) setText('')
      if (input.attachmentToken === attachment?.token) { setAttachment(undefined); setAttachmentKind(undefined) }
      if (input.quotedMessageId === replyTo?.id) setReplyTo(undefined)
      queryClient.setQueryData<DraftDto>(['draft', chat.id], { chatId: chat.id, text: '', updatedAt: Date.now() })
    },
    onSuccess: () => {
      scrollToNewest()
    },
    onError: (error) => {
      pushNotice(errorMessage(error))
      void window.warish.drafts.get(chat.id).then((draft) => {
        queryClient.setQueryData(['draft', chat.id], draft)
        if (!draft) return
        setText((current) => current || draft.text)
        setAttachment((current) => current ?? draft.attachment)
        setAttachmentKind((current) => current ?? draft.attachmentKind)
      }).catch(() => undefined)
    },
    onSettled: () => { pendingOwnSendRef.current = false }
  })
  const submitMessage = (): void => {
    if (chat.readOnly || sendMutation.isPending || session.phase !== 'connected' || (!text.trim() && !attachment)) return
    const restrictedContactAcknowledged = chat.crm?.restricted
      ? window.confirm(`Send a new message to ${chat.crm.name ?? chat.title}? This contact is marked as restricted in CRM.`)
      : false
    if (chat.crm?.restricted && !restrictedContactAcknowledged) return
    sendMutation.mutate({ chatId: chat.id, clientId: crypto.randomUUID(), text: text.trim() || undefined,
      attachmentToken: attachment?.token, attachmentKind, quotedMessageId: replyTo?.id, restrictedContactAcknowledged })
  }
  const earlierMutation = useMutation({
    mutationFn: () => window.warish.messages.loadEarlier(chat.id),
    onSuccess: (result) => {
      setRemoteHistory((current) => [...result.items, ...current])
      setRemoteHasMore(result.hasMore)
    },
    onError: (error) => pushNotice(errorMessage(error))
  })
  const chatAction = useMutation({
    mutationFn: ({ patch }: { patch: Partial<Pick<ChatSummary, 'archived' | 'pinned' | 'mutedUntil'>>; hide?: boolean }) =>
      window.warish.chats.update(chat.id, patch),
    onSuccess: (_data, input) => {
      setConversationMenuOpen(false)
      if (input.hide) onChatHidden()
    },
    onError: (error) => pushNotice(errorMessage(error))
  })
  useEffect(() => {
    setRemoteHistory([])
    setRemoteHasMore(true)
    setNewMessageCount(0)
    nearBottomRef.current = true
    anchorRef.current = undefined
    setConversationMenuOpen(false)
    setContactDrawerOpen(false)
    setSearchOpen(false)
    setMessageSearch('')
    setFocusedMessageId(undefined)
    setCrmCapture(undefined)
    if (recorder.current?.state === 'recording') {
      recorder.current.ondataavailable = null
      recorder.current.onstop = null
      recorder.current.stop()
      recorder.current.stream.getTracks().forEach((track) => track.stop())
    }
    recorder.current = undefined
    if (recordingTimer.current !== undefined) window.clearInterval(recordingTimer.current)
    recordingTimer.current = undefined
    setIsRecording(false)
    setRecordingSeconds(0)
  }, [chat.id])

  useEffect(() => {
    if (!focusedMessageId) return
    const index = timeline.findIndex((item) => item.type === 'message' && item.message.id === focusedMessageId)
    if (index < 0) return
    const frame = requestAnimationFrame(() => virtualizer.scrollToIndex(index + 1, { align: 'center' }))
    return () => cancelAnimationFrame(frame)
  }, [focusedMessageId, timeline, virtualizer])

  useLayoutEffect(() => {
    const textarea = composerRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 112)}px`
  }, [text])

  useEffect(() => {
    const element = parentRef.current
    if (!element) return
    const updateScrollState = (): void => {
      if (scrollStateFrameRef.current !== undefined) return
      scrollStateFrameRef.current = requestAnimationFrame(() => {
        scrollStateFrameRef.current = undefined
        nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120
        if (nearBottomRef.current) setNewMessageCount(0)
        captureAnchor()
      })
    }
    updateScrollState()
    element.addEventListener('scroll', updateScrollState, { passive: true })
    const resizeObserver = new ResizeObserver(() => {
      const shouldFollow = nearBottomRef.current
      setMessageViewportHeight(element.clientHeight)
      measureRenderedRows()
      if (shouldFollow && messages.length) scrollToNewest(false)
      else captureAnchor()
    })
    resizeObserver.observe(element)
    setMessageViewportHeight(element.clientHeight)
    return () => {
      element.removeEventListener('scroll', updateScrollState)
      resizeObserver.disconnect()
      if (scrollStateFrameRef.current !== undefined) cancelAnimationFrame(scrollStateFrameRef.current)
      scrollStateFrameRef.current = undefined
    }
  }, [captureAnchor, measureRenderedRows, messages.length, scrollToNewest])

  useLayoutEffect(() => {
    const previous = previousMessagesRef.current
    if (activeChatRef.current !== chat.id) {
      activeChatRef.current = chat.id
      previousMessagesRef.current = messages
      if (messages.length) scrollToNewest()
      return
    }

    const previousIds = new Set(previous.map((message) => message.id))
    const added = messages.filter((message) => !previousIds.has(message.id))
    const previousNewest = previous.at(-1)
    const newerCount = previousNewest
      ? added.filter((message) => compareMessages(message, previousNewest) > 0).length
      : added.length
    const shouldFollow = nearBottomRef.current || pendingOwnSendRef.current

    if (added.length && shouldFollow) {
      scrollToNewest()
    } else if (added.length && anchorRef.current) {
      restoreAnchor(anchorRef.current)
      if (newerCount) setNewMessageCount((count) => count + newerCount)
    } else if (newerCount && !shouldFollow) {
      setNewMessageCount((count) => count + newerCount)
    }
    previousMessagesRef.current = messages
  }, [chat.id, messages, restoreAnchor, scrollToNewest, virtualizer])

  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
      if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current)
      if (rowResizeFrameRef.current !== undefined) cancelAnimationFrame(rowResizeFrameRef.current)
      if (focusTimerRef.current !== undefined) window.clearTimeout(focusTimerRef.current)
      if (recordingTimer.current !== undefined) window.clearInterval(recordingTimer.current)
      if (recorder.current?.state === 'recording') {
        recorder.current.ondataavailable = null
        recorder.current.onstop = null
        recorder.current.stop()
        recorder.current.stream.getTracks().forEach((track) => track.stop())
      }
    }
  }, [])

  const chooseAttachment = async (): Promise<void> => {
    try {
      const picked = await window.warish.media.pick()
      if (!picked) return
      if (!activeRef.current) {
        await window.warish.media.discardDraft(picked.token)
        return
      }
      if (attachment && attachment.token !== picked.token) void window.warish.media.discardDraft(attachment.token)
      setAttachment(picked)
      setAttachmentKind(inferAttachmentKind(picked))
    } catch (error) { pushNotice(errorMessage(error)) }
  }
  const stopRecording = (cancel: boolean): void => {
    if (recorder.current?.state !== 'recording') return
    recordingCancelledRef.current = cancel
    recorder.current.stop()
    setIsRecording(false)
    if (recordingTimer.current !== undefined) window.clearInterval(recordingTimer.current)
    recordingTimer.current = undefined
  }
  const toggleRecording = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
      if (!activeRef.current) { stream.getTracks().forEach((track) => track.stop()); return }
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
      const chunks: Blob[] = []
      const next = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 })
      next.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
      next.onerror = (event) => {
        stream.getTracks().forEach((track) => track.stop())
        if (recordingTimer.current !== undefined) window.clearInterval(recordingTimer.current)
        recordingTimer.current = undefined
        recorder.current = undefined
        if (activeRef.current) setIsRecording(false)
        onMediaRecorderError(event, pushNotice)
      }
      next.onstop = () => {
        stream.getTracks().forEach((track) => track.stop())
        recorder.current = undefined
        if (recordingTimer.current !== undefined) window.clearInterval(recordingTimer.current)
        recordingTimer.current = undefined
        if (recordingCancelledRef.current || !activeRef.current) return
        void (async () => {
          try {
            const blob = new Blob(chunks, { type: mimeType })
            if (!blob.size) throw new Error('The recording was empty')
            const picked = await window.warish.media.saveRecording(new Uint8Array(await blob.arrayBuffer()), mimeType)
            if (!activeRef.current) { await window.warish.media.discardDraft(picked.token); return }
            if (attachment) void window.warish.media.discardDraft(attachment.token)
            setAttachment(picked)
            setAttachmentKind('voice')
          } catch (error) { pushNotice(errorMessage(error)) }
        })()
      }
      recorder.current = next
      recordingCancelledRef.current = false
      next.start(500)
      setRecordingSeconds(0)
      recordingTimer.current = window.setInterval(() => setRecordingSeconds((seconds) => {
        const nextSeconds = seconds + 1
        if (nextSeconds >= 15 * 60) stopRecording(false)
        return nextSeconds
      }), 1_000)
      setIsRecording(true)
    } catch (error) {
      setIsRecording(false)
      pushNotice(errorMessage(error))
    }
  }
  const revealMessage = async (messageId: string): Promise<void> => {
    try {
      if (!messages.some((message) => message.id === messageId)) {
        const context = await window.warish.messages.context(chat.id, messageId, 20)
        setRemoteHistory((current) => mergeMessages(current, context.items))
      }
      setFocusedMessageId(messageId)
      if (focusTimerRef.current !== undefined) window.clearTimeout(focusTimerRef.current)
      focusTimerRef.current = window.setTimeout(() => setFocusedMessageId((current) => current === messageId ? undefined : current), 2_500)
    } catch (error) { pushNotice(errorMessage(error)) }
  }
  const selectSearchResult = (message: MessageDto): void => {
    void revealMessage(message.id)
    setSearchOpen(false)
  }
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setConversationMenuOpen(false)
        setContactDrawerOpen(false)
        setSearchOpen(true)
      } else if (event.key === 'Escape') {
        setConversationMenuOpen(false)
        setSearchOpen(false)
        setContactDrawerOpen(false)
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  const conversationIdentity = contactIdentityPresentation(chat)
  return <>
    <header className="conversation-header"><button className="conversation-identity" title={chat.kind === 'direct' ? 'Open customer details' : 'Open conversation info'} onClick={() => { setSearchOpen(false); setConversationMenuOpen(false); setContactDrawerOpen(true) }}><Avatar title={conversationIdentity.primary} src={chat.avatarUrl} /><span title={chat.description}><strong>{conversationIdentity.primary}</strong>{chat.kind === 'direct'
      ? <span className="conversation-crm-line">{chat.crm?.name && chat.crm.name !== conversationIdentity.primary && <span className="conversation-crm-alias">CRM: {chat.crm.name}</span>}
        {conversationIdentity.profileName && <span className="whatsapp-profile-pill">{conversationIdentity.profileName}</span>}
        {chat.crm && <><span className="conversation-stage" style={{ '--stage-color': chat.crm.stageColor } as React.CSSProperties}><i />{chat.crm.stageName}</span>
          {chat.crm.nextTask && <span className="conversation-next-task"><CalendarClock />{chat.crm.nextTask.title}</span>}</>}</span>
      : <span>{chatSubtitle(chat)}</span>}</span></button>
      <button className={`icon-button ${searchOpen ? 'active' : ''}`} title="Search this conversation" aria-label="Search this conversation" aria-expanded={searchOpen} onClick={() => { setConversationMenuOpen(false); setContactDrawerOpen(false); setSearchOpen((open) => !open) }}><Search /></button>
      <button className="icon-button" title="Conversation menu" aria-label="Conversation menu" aria-haspopup="menu" aria-expanded={conversationMenuOpen} onClick={() => { setSearchOpen(false); setContactDrawerOpen(false); setConversationMenuOpen((open) => !open) }}><Menu /></button>
      {conversationMenuOpen && <><button className="menu-dismiss" aria-label="Close menu" onClick={() => setConversationMenuOpen(false)} /><div className="header-menu conversation-header-menu" role="menu">
        <button role="menuitem" disabled={chatAction.isPending} onClick={() => chatAction.mutate({ patch: { pinned: !chat.pinned } })}>{chat.pinned ? <PinOff /> : <Pin />}{chat.pinned ? 'Unpin chat' : 'Pin chat'}</button>
        <button role="menuitem" onClick={() => { void window.warish.chats.markRead(chat.id).catch((error) => pushNotice(errorMessage(error))); setConversationMenuOpen(false) }}><CheckCheck />Mark as read</button>
        <button role="menuitem" disabled={chatAction.isPending} onClick={() => chatAction.mutate({ patch: { archived: !chat.archived }, hide: true })}>{chat.archived ? <ArchiveRestore /> : <Archive />}{chat.archived ? 'Unarchive chat' : 'Archive chat'}</button>
      </div></>}
    </header>
    <div className="message-scroller" ref={parentRef}>
      {messageQuery.isError && <QueryError label="Could not load messages" onRetry={() => void messageQuery.refetch()} />}
      <div className="virtual-message-list" style={{ height: Math.max(virtualMessageHeight, messageViewportHeight) }}>
        {virtualizer.getVirtualItems().map((item) => {
          if (item.index === 0) return <div key={String(item.key)} ref={virtualizer.measureElement} data-index={item.index} className="virtual-message history-controls" style={{ transform: `translateY(${item.start + virtualMessageOffset}px)` }}>
            {messageQuery.hasNextPage
              ? <button className="load-older" onClick={() => { captureAnchor(); void messageQuery.fetchNextPage() }}>{messageQuery.isFetchingNextPage ? <LoaderCircle className="spin" /> : <ArrowUp />} Load older messages</button>
              : !chat.readOnly && remoteHasMore && messages.length > 0
                ? <button className="load-older" disabled={earlierMutation.isPending} onClick={() => { captureAnchor(); earlierMutation.mutate() }}>{earlierMutation.isPending ? <LoaderCircle className="spin" /> : <ArrowUp />} {earlierMutation.isPending ? 'Requesting earlier messages…' : 'Load earlier messages from phone'}</button>
                : messages.length > 0 && <div className="history-start">Beginning of available conversation</div>}
          </div>
          const timelineItem = timeline[item.index - 1]!
          if (timelineItem.type === 'date') return <div key={String(item.key)} ref={virtualizer.measureElement} data-index={item.index}
            className="virtual-message date-separator-row" style={{ transform: `translateY(${item.start + virtualMessageOffset}px)` }}><div className="date-separator">{timelineItem.label}</div></div>
          const message = timelineItem.message
          const groupPosition = groupPositionById.get(message.id) ?? 'single'
          return <div key={String(item.key)} ref={virtualizer.measureElement} data-index={item.index} data-message-id={message.id}
            className={`virtual-message message-item group-${groupPosition} ${message.id === focusedMessageId ? 'search-target' : ''}`} style={{ transform: `translateY(${item.start + virtualMessageOffset}px)` }}>
            <MessageBubble message={message} groupPosition={groupPosition} readOnly={chat.readOnly} showSender={showSenderById.get(message.id) ?? false} onReply={setReplyTo} onForward={onForward}
              onAddNote={chat.kind === 'direct' ? (source) => setCrmCapture({ kind: 'note', message: source }) : undefined}
              onAddTask={chat.kind === 'direct' ? (source) => setCrmCapture({ kind: 'task', message: source }) : undefined}
              onOpenQuote={(messageId) => void revealMessage(messageId)} onResize={handleRowResize}
              onRetry={(messageId) => void window.warish.messages.retry(messageId).catch((error) => pushNotice(errorMessage(error)))}
              onError={(error) => pushNotice(errorMessage(error))} />
          </div>
        })}
      </div>
    </div>
    {searchOpen && <aside className="conversation-search-panel">
      <header><strong>Search messages</strong><button className="icon-button" title="Close search" onClick={() => setSearchOpen(false)}><X /></button></header>
      <label className="search-box conversation-search-box"><Search /><input autoFocus value={messageSearch} onChange={(event) => setMessageSearch(event.target.value)} placeholder="Search this conversation" />{messageSearch && <button onClick={() => setMessageSearch('')}><X /></button>}</label>
      <div className="conversation-search-results" onScroll={(event) => {
        const element = event.currentTarget
        if (element.scrollHeight - element.scrollTop - element.clientHeight < 160 && messageSearchQuery.hasNextPage && !messageSearchQuery.isFetchingNextPage) void messageSearchQuery.fetchNextPage()
      }}>
        {!messageSearch.trim() && <div className="search-hint">Type a word or phrase to search this chat.</div>}
        {messageSearchQuery.isFetching && <LoadingRow label="Searching messages…" />}
        {messageSearchQuery.isError && <QueryError label="Search failed" onRetry={() => void messageSearchQuery.refetch()} />}
        {debouncedMessageSearch.trim() && !messageSearchQuery.isFetching && messageSearchResults.length === 0 && <div className="search-hint">No matching messages found.</div>}
        {messageSearchResults.map((message) => <button key={message.id} className="message-search-result" onClick={() => selectSearchResult(message)}><span><strong>{message.fromMe ? 'You' : message.senderName ?? chat.title}</strong><time>{format(new Date(message.timestamp), 'dd/MM/yy HH:mm')}</time></span><p>{message.text ?? message.kind}</p></button>)}
        {messageSearchQuery.isFetchingNextPage && <LoadingRow label="Loading more matches…" />}
      </div>
    </aside>}
    {contactDrawerOpen && <Suspense fallback={<aside className="contact-drawer"><LoadingRow label="Loading customer details…" /></aside>}><ContactDrawer chat={chat} onClose={() => setContactDrawerOpen(false)} onArchived={() => {
      setContactDrawerOpen(false)
      onChatHidden()
    }} onJumpToMessage={(messageId) => { setContactDrawerOpen(false); void revealMessage(messageId) }} /></Suspense>}
    {crmCapture && <CrmCaptureDialog chat={chat} capture={crmCapture} onClose={() => setCrmCapture(undefined)} />}
    {newMessageCount > 0 && <button className="new-messages-button" onClick={() => scrollToNewest()}><ArrowDown />{newMessageCount} new {newMessageCount === 1 ? 'message' : 'messages'}</button>}
    {!chat.readOnly && (replyTo || attachment) && <div className="composer-context">
      <div>{replyTo && <><strong>Replying to {replyTo.senderName ?? (replyTo.fromMe ? 'yourself' : chat.title)}</strong><span>{replyTo.text ?? replyTo.kind}</span></>}{attachment && <><strong>{attachmentKind === 'voice' ? 'Voice message' : attachment.name}</strong><span>{formatBytes(attachment.size)}</span></>}</div>
      <button aria-label="Clear reply or attachment" onClick={() => {
        setReplyTo(undefined)
        if (attachment) void window.warish.media.discardDraft(attachment.token)
        setAttachment(undefined)
        setAttachmentKind(undefined)
      }}><X /></button>
    </div>}
    {chat.readOnly ? <footer className="read-only-composer"><Radio /><span>Channels are read-only in WArish</span></footer> : <footer className="composer">
      <button className="icon-button" title="Emoji" onClick={() => setText((value) => `${value} 😊`)}><Smile /></button>
      <button className="icon-button" title="Attach" aria-label="Attach a file" disabled={isRecording} onClick={() => void chooseAttachment()}><Paperclip /></button>
      <textarea ref={composerRef} value={text} rows={1} aria-label="Message" placeholder={isRecording ? `Recording… ${formatDuration(recordingSeconds)}` : session.phase === 'connected' ? 'Type a message' : 'Type a draft — reconnect to send'} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
        if (shouldSubmitComposer(event, enterToSend)) { event.preventDefault(); submitMessage() }
      }} />
      {isRecording ? <><button className="icon-button recording" title="Cancel recording" aria-label="Cancel recording" onClick={() => stopRecording(true)}><X /></button>
        <button className="send-button" title="Finish recording" aria-label="Finish recording" onClick={() => stopRecording(false)}><Square /></button></>
        : !text.trim() && !attachment ? <button className="icon-button" title="Voice message" aria-label="Record a voice message" onClick={() => void toggleRecording()}><Mic /></button>
          : <button className="send-button" title={session.phase === 'connected' ? 'Send' : 'Reconnect to send'} aria-label="Send message"
            disabled={sendMutation.isPending || session.phase !== 'connected'} onClick={submitMessage}>{sendMutation.isPending ? <LoaderCircle className="spin" /> : <Send />}</button>}
    </footer>}
  </>
}

function CrmCaptureDialog({ chat, capture, onClose }: {
  chat: ChatSummary
  capture: { kind: 'note' | 'task'; message: MessageDto }
  onClose(): void
}): React.JSX.Element {
  const preview = messagePreview(capture.message)
  const [body, setBody] = useState(preview)
  const [title, setTitle] = useState('Follow up on WhatsApp')
  const [description, setDescription] = useState(preview)
  const [due, setDue] = useState(toLocalDateTimeInput(Date.now() + 24 * 60 * 60 * 1000))
  const [priority, setPriority] = useState<CrmTaskDto['priority']>('normal')
  const queryClient = useQueryClient()
  const pushNotice = useUiStore((state) => state.pushNotice)
  const save = useMutation({ mutationFn: async () => {
    let contactId = chat.crm?.contactId
    if (!contactId) {
      const contact = await window.warish.crm.contacts.ensure(chat.id)
      contactId = contact.id
      queryClient.setQueryData<CrmContactDetailsDto>(['crm', 'contact', contact.id], contact)
      queryClient.setQueryData<CrmContactDetailsDto>(['crm', 'contact', 'chat', chat.id], contact)
    }
    if (capture.kind === 'note') return window.warish.crm.notes.save({ contactId, body, sourceMessageId: capture.message.id })
    return window.warish.crm.tasks.save({ contactId, title, description, dueAt: due ? new Date(due).getTime() : undefined,
      priority, sourceMessageId: capture.message.id })
  }, onSuccess: () => {
    void queryClient.invalidateQueries({ queryKey: ['crm'] })
    void queryClient.invalidateQueries({ queryKey: ['chats'] })
    pushNotice(capture.kind === 'note' ? 'Message added to CRM notes' : 'Follow-up task created', 'info')
    onClose()
  }, onError: (error) => pushNotice(errorMessage(error)) })
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="modal crm-capture-dialog" role="dialog" aria-modal="true" aria-label={capture.kind === 'note' ? 'Add CRM note' : 'Create follow-up task'}>
    <header><div><span>{capture.kind === 'note' ? 'CRM note' : 'Follow-up task'}</span><h2>{capture.kind === 'note' ? 'Add message to notes' : 'Create task from message'}</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}><X /></button></header>
    <form onSubmit={(event) => { event.preventDefault(); save.mutate() }}><div className="crm-capture-source"><MessageCircle /><span><small>{capture.message.fromMe ? 'You' : capture.message.senderName ?? chat.title}</small><strong>{preview}</strong></span></div>
      {capture.kind === 'note' ? <label><span>Note</span><textarea autoFocus value={body} onChange={(event) => setBody(event.target.value)} required /></label>
        : <><label><span>Task</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
          <label><span>Notes</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <div className="form-grid"><label><span>Due</span><input type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} /></label>
            <label><span>Priority</span><select value={priority} onChange={(event) => setPriority(event.target.value as CrmTaskDto['priority'])}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></label></div></>}
      <footer><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button"
        disabled={save.isPending || (capture.kind === 'note' ? !body.trim() : !title.trim())}>{save.isPending ? 'Saving…' : capture.kind === 'note' ? <><NotebookPen />Add note</> : <><ListTodo />Create task</>}</button></footer>
    </form>
  </section></div>
}

function ForwardDialog({ message, onClose }: { message: MessageDto; onClose(): void }): React.JSX.Element {
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebouncedValue(query, 220)
  const pushNotice = useUiStore((state) => state.pushNotice)
  const chatsQuery = useInfiniteQuery({
    queryKey: ['forward-chats', debouncedQuery],
    queryFn: ({ pageParam }) => window.warish.chats.list({ cursor: pageParam, limit: 50, query: debouncedQuery }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor
  })
  const chats = useMemo(() => chatsQuery.data?.pages.flatMap((page) => page.items).filter((chat) => !chat.readOnly) ?? [], [chatsQuery.data])
  const mutation = useMutation({ mutationFn: (acknowledgements: string[]) => window.warish.messages.forward(message.id, selected, acknowledgements), onSuccess: onClose,
    onError: (error) => pushNotice(errorMessage(error)) })
  const submitForward = (): void => {
    const restricted = chats.filter((chat) => selected.includes(chat.id) && chat.crm?.restricted)
    if (restricted.length && !window.confirm(`Forward this message to ${restricted.map((chat) => chat.crm?.name ?? chat.title).join(', ')}? ${restricted.length === 1 ? 'This contact is' : 'These contacts are'} marked as restricted in CRM.`)) return
    mutation.mutate(restricted.map((chat) => chat.id))
  }
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="modal forward-dialog" role="dialog" aria-modal="true" aria-labelledby="forward-title"><header><h2 id="forward-title">Forward message</h2><button className="icon-button" aria-label="Close forward dialog" onClick={onClose}><X /></button></header>
    <label className="search-box"><Search /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" />{query && <button aria-label="Clear search" onClick={() => setQuery('')}><X /></button>}</label>
    <div className="forward-list" onScroll={(event) => {
      const element = event.currentTarget
      if (element.scrollHeight - element.scrollTop - element.clientHeight < 180 && chatsQuery.hasNextPage && !chatsQuery.isFetchingNextPage) void chatsQuery.fetchNextPage()
    }}>
      {chatsQuery.isPending && <LoadingRow label="Loading conversations…" />}
      {chatsQuery.isError && <QueryError label="Could not load conversations" onRetry={() => void chatsQuery.refetch()} />}
      {chats.map((chat) => <label key={chat.id}><input type="checkbox" checked={selected.includes(chat.id)} onChange={() => setSelected((items) => items.includes(chat.id) ? items.filter((id) => id !== chat.id) : [...items, chat.id])} /><Avatar title={chat.title} src={chat.avatarUrl} /><span>{chat.title}</span>{selected.includes(chat.id) && <Check />}</label>)}
      {chatsQuery.isFetchingNextPage && <LoadingRow label="Loading more conversations…" />}
    </div><footer><button onClick={onClose}>Cancel</button><button className="primary-button" disabled={!selected.length || mutation.isPending} onClick={submitForward}>{mutation.isPending ? 'Forwarding…' : 'Forward'}</button></footer></section></div>
}

function WelcomePanel(): React.JSX.Element { return <div className="welcome-panel"><div className="brand-mark large">W</div><h2>WArish for Windows</h2><p>Select a conversation to start messaging. Your history and credentials remain on this computer.</p></div> }
function LoadingRow({ label }: { label: string }): React.JSX.Element { return <div className="loading-row"><LoaderCircle className="spin" />{label}</div> }
function SkeletonRows(): React.JSX.Element {
  return <div className="skeleton-list" aria-label="Loading conversations">{Array.from({ length: 8 }, (_, index) =>
    <div className="skeleton-row" key={index}><i /><span><b /><b /></span></div>)}</div>
}
function QueryError({ label, onRetry }: { label: string; onRetry(): void }): React.JSX.Element {
  return <div className="query-error" role="alert"><span>{label}</span><button className="secondary-button" onClick={onRetry}>Try again</button></div>
}
function destinationLabel(destination: SidebarDestination): string {
  const labels: Record<SidebarDestination, string> = {
    all: 'All conversations', direct: 'Chats', crm: 'CRM', group: 'Groups', community: 'Communities', channel: 'Channels', archived: 'Archived'
  }
  return labels[destination]
}
function chatSubtitle(chat: ChatSummary): string {
  if (chat.kind === 'channel') return 'Channel · Read only'
  if (chat.communityId) return chat.isAnnouncement ? 'Community announcements' : 'Community group'
  if (chat.kind === 'group') return 'Group conversation'
  if (chat.kind === 'community') return 'Community'
  if (chat.kind === 'direct') return 'WhatsApp contact'
  return 'WhatsApp conversation'
}
function chatTime(timestamp: number): string { const date = new Date(timestamp); return isToday(date) ? format(date, 'HH:mm') : isYesterday(date) ? 'Yesterday' : format(date, 'dd/MM/yy') }
function compactTaskDate(timestamp: number): string {
  const date = new Date(timestamp)
  if (timestamp < Date.now()) return 'Overdue'
  if (isToday(date)) return format(date, 'HH:mm')
  return format(date, 'dd MMM')
}
function compareMessages(left: MessageDto, right: MessageDto): number {
  return left.timestamp - right.timestamp || left.id.localeCompare(right.id)
}
type TimelineItem = { type: 'date'; key: string; label: string } | { type: 'message'; key: string; message: MessageDto }
function buildTimeline(messages: MessageDto[]): TimelineItem[] {
  const items: TimelineItem[] = []
  let previousDate: Date | undefined
  for (const message of messages) {
    const date = new Date(message.timestamp)
    if (!previousDate || !isSameDay(previousDate, date)) {
      const label = isToday(date) ? 'Today' : isYesterday(date) ? 'Yesterday' : format(date, 'EEEE, d MMMM yyyy')
      items.push({ type: 'date', key: `date:${format(date, 'yyyy-MM-dd')}`, label })
    }
    items.push({ type: 'message', key: message.id, message })
    previousDate = date
  }
  return items
}
function mergeMessages(current: MessageDto[], incoming: MessageDto[]): MessageDto[] {
  const merged = new Map(current.map((message) => [message.id, message]))
  for (const message of incoming) merged.set(message.id, message)
  return [...merged.values()].sort(compareMessages)
}
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [delay, value])
  return debounced
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Something went wrong' }
function messagePreview(message: MessageDto): string {
  return (message.text ?? message.rich?.body ?? message.rich?.title ?? message.attachment?.fileName ?? message.kind).trim().slice(0, 500)
}
function toLocalDateTimeInput(value: number): string {
  const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 16)
}
function onMediaRecorderError(_event: Event, notify: (message: string) => void): void {
  notify('Voice recording failed. Check your microphone and try again.')
}
function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
function formatPairingCode(code: string): string { return code.replace(/(.{4})/g, '$1 ').trim() }
function inferAttachmentKind(file: PickedAttachment): 'image' | 'video' | 'document' | 'audio' | 'sticker' {
  if (file.mimeType.startsWith('image/')) return 'image'
  if (file.mimeType.startsWith('video/')) return 'video'
  if (file.mimeType.startsWith('audio/')) return 'audio'
  return 'document'
}
function formatBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB` }
