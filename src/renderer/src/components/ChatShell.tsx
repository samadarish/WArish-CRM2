import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import { format, isSameDay, isToday, isYesterday } from 'date-fns'
import {
  Archive, ArchiveRestore, ArrowDown, ArrowUp, BadgeIndianRupee, BriefcaseBusiness, Check, CheckCheck, ChevronDown, ChevronRight,
  CalendarClock, CircleAlert, Link2, ListTodo, LoaderCircle, Menu, MessageCircle, Mic, NotebookPen, Paperclip,
  Pin, PinOff, Radio, RefreshCw, Search, Send, Settings, ShoppingBag, Smile, Square, WifiOff, X
} from 'lucide-react'
import type { AppSettings, ChatCategory, ChatSummary, CommunitySummary, CrmChatIndicatorDto, CrmContactDetailsDto, CrmTaskDto, DraftDto, MessageDto, Page, PickedAttachment, SessionState } from '../../../shared/contracts'
import { useUiStore } from '../store'
import { shouldSubmitComposer } from '../composer-keyboard'
import { contactIdentityPresentation, type ContactIdentityPresentation } from '../contact-identity'
import { messageGroupPositions } from '../message-grouping'
import { MotionPresence } from '../motion'
import { runSurfaceTransition } from '../surface-transition'
import { MOTION_MS, motionDuration, subscribeToReducedMotion } from '../motion-preference'
import { useDebouncedValue } from '../use-debounced-value'
import { useDialogFocus } from '../use-dialog-focus'
import { Avatar } from './Avatar'
import { DeliveryReceipt } from './DeliveryReceipt'
import { MessageBubble } from './MessageBubble'
import { NavigationRail, type SidebarDestination } from './NavigationRail'
import { SalesLifecyclePath } from './SalesLifecyclePath'
import { DropdownMenu, IconButton, SelectField, Tooltip } from './ui-primitives'

const ContactDrawer = lazy(async () => {
  const module = await import('./ContactDrawer')
  return { default: module.ContactDrawer }
})
const CrmShell = lazy(async () => {
  const module = await import('./CrmShell')
  return { default: module.CrmShell }
})

const COMPOSER_EMOJIS = [
  ['😀', 'Grinning face'], ['😂', 'Face with tears of joy'], ['😊', 'Smiling face'], ['😍', 'Heart eyes'],
  ['🥰', 'Smiling face with hearts'], ['😅', 'Smiling face with sweat'], ['🤔', 'Thinking face'], ['😢', 'Crying face'],
  ['👍', 'Thumbs up'], ['🙏', 'Folded hands'], ['👏', 'Clapping hands'], ['🙌', 'Raising hands'],
  ['👌', 'OK hand'], ['💪', 'Flexed biceps'], ['🤝', 'Handshake'], ['👋', 'Waving hand'],
  ['❤️', 'Red heart'], ['🔥', 'Fire'], ['🎉', 'Party popper'], ['✨', 'Sparkles'],
  ['✅', 'Check mark'], ['💯', 'Hundred points'], ['📞', 'Telephone'], ['💬', 'Speech balloon'],
  ['📦', 'Package'], ['💰', 'Money bag'], ['🕒', 'Clock'], ['📍', 'Location pin']
] as const

export const ChatShell = memo(function ChatShell({ session }: { session: SessionState }): React.JSX.Element {
  const destination = useUiStore((state) => state.destination)
  const navigate = useUiStore((state) => state.navigate)
  const navigateWithTransition = useCallback((next: SidebarDestination): void => runSurfaceTransition('workspace', () => navigate(next)), [navigate])
  if (destination === 'crm') return <div className="crm-shell-frame"><NavigationRail current={destination} onNavigate={navigateWithTransition} />
    <Suspense fallback={<div className="crm-state"><LoaderCircle className="spin" />Opening CRM…</div>}><CrmShell /></Suspense></div>
  return <ConversationShell session={session} />
})

function ConversationShell({ session }: { session: SessionState }): React.JSX.Element {
  const [chatQuery, setChatQuery] = useState('')
  const [forwardMessage, setForwardMessage] = useState<MessageDto>()
  const [expandedCommunities, setExpandedCommunities] = useState<Set<string>>(() => new Set())
  const [sidebarMenuOpen, setSidebarMenuOpen] = useState(false)
  const [relinkOpen, setRelinkOpen] = useState(false)
  const [enteringChatRows, setEnteringChatRows] = useState<Map<string, number>>(() => new Map())
  const [pendingSelectedChatId, setPendingSelectedChatId] = useState<string>()
  const conversationEntryRef = useRef<{ chatId: string; unreadCount: number } | undefined>(undefined)
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
  const hydratedContactIdsRef = useRef<Set<string>>(new Set())
  const knownSidebarIdsRef = useRef<Set<string>>(new Set())
  const revealedSidebarListsRef = useRef<Set<string>>(new Set())
  const chatRowEnterTimerRef = useRef<number | undefined>(undefined)
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: () => window.warish.settings.get() })
  const showChatPreviews = settingsQuery.data?.showChatPreviews ?? true
  const enterToSend = settingsQuery.data?.enterToSend ?? true
  const density = settingsQuery.data?.density ?? 'dense'
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
    if (first) {
      conversationEntryRef.current = { chatId: first.id, unreadCount: first.unreadCount }
      selectChat(first.id)
    }
  }, [chats, communities, destination, selectChat, selectedChatId])
  const listHasNextPage = destination === 'community' ? communitiesQuery.hasNextPage : chatsQuery.hasNextPage
  const listIsFetchingNextPage = destination === 'community' ? communitiesQuery.isFetchingNextPage : chatsQuery.isFetchingNextPage
  const sidebarVirtualizer = useVirtualizer({
    count: sidebarItems.length + (listHasNextPage ? 1 : 0),
    getScrollElement: () => chatListRef.current,
    estimateSize: (index) => {
      const item = sidebarItems[index]
      const crmExtra = item?.type === 'chat' && item.chat.crm ? 18 : 0
      if (density === 'ultra-dense') {
        if (item?.type === 'community') return 50
        const hasMetadata = item?.type === 'chat' && (contactIdentityPresentation(item.chat).hasSecondary || Boolean(item.chat.crm))
        return showChatPreviews ? (hasMetadata ? 56 : 48) : (hasMetadata ? 50 : 44)
      }
      if (density === 'dense') {
        if (item?.type === 'community') return 58
        const hasMetadata = item?.type === 'chat' && (contactIdentityPresentation(item.chat).hasSecondary || Boolean(item.chat.crm))
        return showChatPreviews ? (hasMetadata ? 66 : 56) : (hasMetadata ? 56 : 50)
      }
      if (density === 'compact') {
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
    overscan: 6
  })
  const virtualSidebarItems = sidebarVirtualizer.getVirtualItems()
  useEffect(() => sidebarVirtualizer.measure(), [density, showChatPreviews, sidebarVirtualizer])
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
      .filter((id) => !hydratedContactIdsRef.current.has(id))
    if (!ids.length) return
    for (const id of ids) hydratedContactIdsRef.current.add(id)
    const timer = window.setTimeout(() => {
      void window.warish.contacts.hydrate(ids).catch(() => {
        for (const id of ids) hydratedContactIdsRef.current.delete(id)
      })
    }, 80)
    return () => window.clearTimeout(timer)
  // The stable key prevents a new request when the virtualizer returns equivalent item objects.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrationKey])
  useEffect(() => { hydratedContactIdsRef.current.clear() }, [session.accountState])
  const markRead = useCallback((chatId: string): void => {
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
  }, [pushNotice, queryClient])
  const selectChatRow = useCallback((chat: ChatSummary): void => {
    setPendingSelectedChatId(chat.id)
    conversationEntryRef.current = { chatId: chat.id, unreadCount: chat.unreadCount }
    runSurfaceTransition('chat', () => selectChat(chat.id))
    markRead(chat.id)
  }, [markRead, selectChat])
  useLayoutEffect(() => {
    if (pendingSelectedChatId === selectedChatId) setPendingSelectedChatId(undefined)
  }, [pendingSelectedChatId, selectedChatId])
  const changeDestination = useCallback((next: SidebarDestination): void => {
    runSurfaceTransition('workspace', () => {
      navigate(next)
      setSidebarMenuOpen(false)
      setChatQuery('')
    })
  }, [navigate])
  const toggleCommunity = useCallback((communityId: string): void => setExpandedCommunities((current) => {
    const next = new Set(current)
    if (next.has(communityId)) next.delete(communityId)
    else next.add(communityId)
    return next
  }), [])
  const prefetchChat = useCallback((chat: ChatSummary): void => {
    const requests: Array<Promise<unknown>> = [
      queryClient.prefetchQuery({ queryKey: ['chat', chat.id], queryFn: () => window.warish.chats.get(chat.id), staleTime: 15_000 }),
      queryClient.prefetchInfiniteQuery({
        queryKey: ['messages', chat.id],
        queryFn: ({ pageParam }) => window.warish.messages.list(chat.id, pageParam, 80),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor,
        staleTime: 15_000,
        pages: 1
      })
    ]
    if (chat.kind === 'direct') {
      requests.push(queryClient.prefetchQuery({
        queryKey: ['contact', chat.id], queryFn: () => window.warish.contacts.get(chat.id), staleTime: 15_000
      }))
      if (chat.crm?.contactId) requests.push(queryClient.prefetchQuery({
        queryKey: ['crm', 'contact', chat.crm.contactId],
        queryFn: () => window.warish.crm.contacts.get({ contactId: chat.crm!.contactId }),
        staleTime: 30_000
      }))
      void import('./ContactDrawer')
    }
    void Promise.all(requests)
  }, [queryClient])
  const clearSelectedChat = useCallback((): void => selectChat(), [selectChat])
  useEffect(() => {
    if (chatListRef.current) chatListRef.current.scrollTop = 0
  }, [destination])
  const sidebarPending = destination === 'community' ? communitiesQuery.isPending : chatsQuery.isPending
  const sidebarError = destination === 'community' ? communitiesQuery.isError : chatsQuery.isError
  const sidebarRevealKey = destination
  const sidebarSearchActive = Boolean(debouncedChatQuery.trim())
  const visibleSidebarKey = visibleContactIds.join('|')
  useLayoutEffect(() => {
    if (sidebarPending || sidebarError) return
    const firstReveal = !revealedSidebarListsRef.current.has(sidebarRevealKey)
    const enteringIds = (firstReveal ? visibleContactIds
      : sidebarSearchActive ? []
        : visibleContactIds.filter((id) => !knownSidebarIdsRef.current.has(id))).slice(0, 6)
    revealedSidebarListsRef.current.add(sidebarRevealKey)
    for (const item of sidebarItems) if (item.type === 'chat') knownSidebarIdsRef.current.add(item.chat.id)
    if (!enteringIds.length) return
    if (motionDuration(MOTION_MS.fast) === 0) {
      setEnteringChatRows((current) => current.size ? new Map() : current)
      return
    }
    setEnteringChatRows(new Map(enteringIds.map((id, index) => [id, index])))
    if (chatRowEnterTimerRef.current !== undefined) window.clearTimeout(chatRowEnterTimerRef.current)
    chatRowEnterTimerRef.current = window.setTimeout(() => {
      chatRowEnterTimerRef.current = undefined
      setEnteringChatRows(new Map())
    }, MOTION_MS.slow + 100)
  // `visibleSidebarKey` keeps metadata refreshes and list reordering visually quiet.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarError, sidebarItems, sidebarPending, sidebarRevealKey, sidebarSearchActive, visibleSidebarKey])
  useEffect(() => () => {
    if (chatRowEnterTimerRef.current !== undefined) window.clearTimeout(chatRowEnterTimerRef.current)
  }, [])
  useEffect(() => subscribeToReducedMotion(() => {
    if (chatRowEnterTimerRef.current !== undefined) window.clearTimeout(chatRowEnterTimerRef.current)
    chatRowEnterTimerRef.current = undefined
    setEnteringChatRows((current) => current.size ? new Map() : current)
  }), [])

  return (
    <div className="chat-shell">
      <NavigationRail current={destination} onNavigate={changeDestination} />
      <aside className={`chat-list-panel ${showChatPreviews ? '' : 'chat-previews-hidden'}`}>
        <header className="panel-header"><h1>{destinationLabel(destination)}</h1><DropdownMenu label="Chat list menu" icon={<Menu />}
          isOpen={sidebarMenuOpen} onOpenChange={setSidebarMenuOpen} items={[
            { id: 'archive', label: showArchived ? 'All conversations' : 'Archived',
              icon: showArchived ? <MessageCircle /> : <Archive />, onAction: () => changeDestination(showArchived ? 'all' : 'archived') },
            { id: 'settings', label: 'Settings', icon: <Settings />, onAction: () => { setSidebarMenuOpen(false); setSettingsOpen(true) } }
          ]} />
        </header>
        <label className="search-box"><Search /><input value={chatQuery} onChange={(event) => setChatQuery(event.target.value)} placeholder={`Search ${destinationLabel(destination).toLowerCase()}`} />{chatQuery && <IconButton className="" label="Clear chat search" onClick={() => setChatQuery('')}><X /></IconButton>}</label>
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
                  onToggle={toggleCommunity} />
                  : item?.type === 'chat' ? <ChatRow chat={item.chat} nested={item.nested}
                    active={item.chat.id === (pendingSelectedChatId ?? selectedChatId)} showPreview={showChatPreviews} onSelect={selectChatRow}
                    enterIndex={enteringChatRows.get(item.chat.id)} onPrefetch={prefetchChat} />
                    : <LoadingRow label={destination === 'community' ? 'Loading more communities…' : 'Loading more conversations…'} />}
              </div>
            })}
          </div>}
        </div>
      </aside>
      <main className={`conversation-panel ${selectedChat?.kind === 'direct' ? 'has-sales-lifecycle has-persistent-details' : ''}`}>
        {session.phase !== 'connected' && <SessionBanner session={session} retryPending={reconnectMutation.isPending}
          onRetry={() => reconnectMutation.mutate()} onRelink={() => setRelinkOpen(true)} onSettings={() => setSettingsOpen(true)} />}
        {session.phase === 'connected' && session.historySync?.state === 'running' &&
          <div className="connection-banner history-sync-banner"><LoaderCircle className="spin" />Syncing recent history — {Math.round(session.historySync.progress)}%</div>}
        {selectedChatQuery.isError ? <QueryError label="Could not open this conversation" onRetry={() => void selectedChatQuery.refetch()} />
          : selectedChat ? <Conversation key={selectedChat.id} chat={selectedChat}
            initialUnreadCount={conversationEntryRef.current?.chatId === selectedChat.id
              ? conversationEntryRef.current.unreadCount : selectedChat.unreadCount}
            session={session} enterToSend={enterToSend}
            onForward={setForwardMessage} onChatHidden={clearSelectedChat} />
            : selectedChatId && selectedChatQuery.isPending ? <div className="conversation-uncached-skeleton"><MessageHistorySkeleton /></div>
              : <WelcomePanel />}
      </main>
      <MotionPresence show={Boolean(forwardMessage)}>{forwardMessage && <ForwardDialog message={forwardMessage} onClose={() => setForwardMessage(undefined)} />}</MotionPresence>
      <MotionPresence show={relinkOpen}>{relinkOpen && <RelinkDialog session={session} onClose={() => setRelinkOpen(false)} />}</MotionPresence>
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

export function RelinkDialog({ session, onClose }: { session: SessionState; onClose(): void }): React.JSX.Element {
  const [phone, setPhone] = useState('')
  const dialogRef = useDialogFocus<HTMLElement>(onClose)
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
  const mutationError = qrMutation.error ?? codeMutation.error
  const statusMessage = mutationError ? errorMessage(mutationError)
    : (session.phase === 'offline' || session.phase === 'error') ? session.message : undefined
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section ref={dialogRef}
    className="modal relink-dialog" role="dialog" aria-modal="true" aria-labelledby="relink-title" tabIndex={-1}>
    <header><div><h2 id="relink-title">Relink WhatsApp</h2><p>Your local conversations and preferences will remain unchanged.</p></div>
      <IconButton label="Close relink dialog" onClick={onClose}><X /></IconButton></header>
    <div className="relink-content">{session.qrDataUrl ? <div className="relink-qr"><img className="qr-code" src={session.qrDataUrl} alt="WhatsApp linked-device QR code" /><div><strong>Scan with your phone</strong><ol><li>Open WhatsApp</li><li>Open Linked devices</li><li>Choose Link a device</li></ol></div></div>
      : session.pairingCode ? <div className="code-view"><strong>{formatPairingCode(session.pairingCode)}</strong><p>Enter this code from WhatsApp → Linked devices → Link a device.</p></div>
        : session.phase === 'pairing' && !mutationError ? <div className="loading-row"><LoaderCircle className="spin" />Preparing a secure pairing code…</div>
          : <>{statusMessage && <div className="relink-status" role="alert"><CircleAlert /><span>{statusMessage}</span></div>}
            <div className="relink-callout"><Link2 /><div><strong>Reconnect this device</strong><span>Choose QR for the quickest setup, or request a phone-number pairing code.</span></div></div>
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

const CommunityParentRow = memo(function CommunityParentRow({ community, expanded, onToggle }: {
  community: CommunitySummary
  expanded: boolean
  onToggle(communityId: string): void
}): React.JSX.Element {
  return <button className="community-parent" aria-expanded={expanded} onClick={() => onToggle(community.id)}>
      {expanded ? <ChevronDown /> : <ChevronRight />}
      <Avatar title={community.title} src={community.avatarUrl} />
      <span className="community-copy"><span><strong>{community.title}</strong>{community.lastMessageAt && <time>{chatTime(community.lastMessageAt)}</time>}</span>
        <span>{community.children.length} {community.children.length === 1 ? 'group' : 'groups'}{community.unreadCount > 0 && <b>{community.unreadCount > 99 ? '99+' : community.unreadCount}</b>}</span></span>
    </button>
})

const ChatRow = memo(function ChatRow({ chat, active, showPreview, nested = false, enterIndex, onSelect, onPrefetch }: {
  chat: ChatSummary; active: boolean; showPreview: boolean; nested?: boolean
  enterIndex?: number
  onSelect(chat: ChatSummary): void; onPrefetch(chat: ChatSummary): void
}): React.JSX.Element {
  const identity = contactIdentityPresentation(chat)
  return <button className={`chat-row ${chat.kind === 'direct' ? 'direct' : ''} ${identity.hasSecondary ? 'has-identity' : ''} ${chat.crm ? 'has-crm' : ''} ${nested ? 'nested' : ''} ${active ? 'active' : ''} ${enterIndex === undefined ? '' : 'chat-row-enter'}`}
    style={enterIndex === undefined ? undefined : { '--row-enter-delay': `${Math.min(100, enterIndex * 20)}ms` } as React.CSSProperties}
    onMouseEnter={() => onPrefetch(chat)} onFocus={() => onPrefetch(chat)} onClick={() => onSelect(chat)}>
    <Avatar title={identity.primary} src={chat.avatarUrl} /><span className="chat-row-copy"><span className="chat-row-top"><strong title={identity.primary}>{identity.primary}</strong>{chat.lastMessageAt && <time>{chatTime(chat.lastMessageAt)}</time>}{!showPreview && chat.unreadCount > 0 && <b>{chat.unreadCount > 99 ? '99+' : chat.unreadCount}</b>}</span>
      {(identity.hasSecondary || chat.crm) && <span className="chat-row-metadata">
        {identity.hasSecondary && <ContactIdentityDetails identity={identity} />}
        {chat.crm && <ChatCrmSignal crm={chat.crm} />}
      </span>}
      {showPreview && <span className="chat-row-bottom"><span className="chat-preview">
        {!chat.typing && chat.lastMessageFromMe && chat.lastMessageStatus && <DeliveryReceipt className="chat-delivery-receipt" status={chat.lastMessageStatus} />}
        <span className="chat-preview-text">{chat.typing ? 'typing…' : chat.lastMessage ?? 'No messages yet'}</span>
      </span>{chat.unreadCount > 0 && <b>{chat.unreadCount > 99 ? '99+' : chat.unreadCount}</b>}</span>}</span>
  </button>
})

function ChatCrmSignal({ crm }: { crm: CrmChatIndicatorDto }): React.JSX.Element {
  return <span className="chat-crm-signal"><span style={{ '--stage-color': crm.stageColor } as React.CSSProperties}><i />{crm.stageName}</span>
    {crm.nextTask && <span className={crm.nextTask.dueAt && crm.nextTask.dueAt < Date.now() ? 'overdue' : ''}><CalendarClock />{crm.nextTask.dueAt ? compactTaskDate(crm.nextTask.dueAt) : 'Next task'}</span>}</span>
}

function ContactIdentityDetails({ identity, header = false }: { identity: ContactIdentityPresentation; header?: boolean }): React.JSX.Element {
  return <span className={`${header ? 'conversation-contact-identity' : 'chat-row-identity'} contact-identity-details`}>
    {identity.profileName && <span className="whatsapp-profile-pill" title={identity.profileName}>{identity.profileName}</span>}
  </span>
}

const CustomerSummaryStrip = memo(function CustomerSummaryStrip({ chat, onOpenDetails }: { chat: ChatSummary; onOpenDetails(): void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const pushNotice = useUiStore((state) => state.pushNotice)
  const contactQuery = useQuery({
    queryKey: ['crm', 'contact', chat.crm?.contactId],
    queryFn: () => window.warish.crm.contacts.get({ contactId: chat.crm!.contactId }),
    enabled: Boolean(chat.crm?.contactId),
    staleTime: 30_000
  })
  const ensure = useMutation({
    mutationFn: () => window.warish.crm.contacts.ensure(chat.id),
    onSuccess: async (contact) => {
      queryClient.setQueryData(['crm', 'contact', contact.id], contact)
      queryClient.setQueryData(['crm', 'contact', 'chat', chat.id], contact)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['chat', chat.id] }),
        queryClient.invalidateQueries({ queryKey: ['chats'] })
      ])
    },
    onError: (error) => pushNotice(errorMessage(error))
  })
  if (!chat.crm) return <div className="customer-summary customer-summary-untracked">
    <button disabled={ensure.isPending} onClick={() => ensure.mutate()}><BriefcaseBusiness /><span><strong>Not tracked in CRM</strong>
      <small>{ensure.isPending ? 'Adding customer…' : 'Add customer'}</small></span></button>
  </div>
  const contact = contactQuery.data
  const nextTask = chat.crm.nextTask
  return <div className="customer-summary" role="group" aria-label="Customer CRM summary">
    <span className="customer-summary-item"><ShoppingBag /><span><strong>{contact?.orderCount ?? '—'}</strong><small>Orders</small></span></span>
    <span className="customer-summary-item customer-summary-value"><BadgeIndianRupee /><span><strong>{contact ? formatHeaderMoney(contact.lifetimeValue) : '—'}</strong><small>Lifetime value</small></span></span>
    <span className="customer-summary-item"><ListTodo /><span><strong>{contact?.openTaskCount ?? chat.crm.openTaskCount}</strong><small>Open tasks</small></span></span>
    <span className="customer-summary-item customer-summary-next"><CalendarClock /><span><strong>{nextTask?.title ?? 'No follow-up'}</strong>
      <small>{nextTask?.dueAt ? compactTaskDate(nextTask.dueAt) : 'Next task'}</small></span></span>
    <button className="customer-summary-compact" aria-label="Open customer CRM summary" onClick={onOpenDetails}><BriefcaseBusiness />
      <span>CRM</span><b>{contact?.openTaskCount ?? chat.crm.openTaskCount}</b></button>
  </div>
})

function formatHeaderMoney(value: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(value)
}

function Conversation({ chat, initialUnreadCount, session, enterToSend, onForward, onChatHidden }: {
  chat: ChatSummary
  initialUnreadCount: number
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
  const [enteringMessageIds, setEnteringMessageIds] = useState<Set<string>>(() => new Set())
  const [replyTo, setReplyTo] = useState<MessageDto>()
  const [crmCapture, setCrmCapture] = useState<{ kind: 'note' | 'task'; message: MessageDto }>()
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [restrictedSendOpen, setRestrictedSendOpen] = useState(false)
  const [attachment, setAttachment] = useState<PickedAttachment>()
  const [attachmentKind, setAttachmentKind] = useState<'image' | 'video' | 'document' | 'audio' | 'voice' | 'sticker'>()
  const showPersistentDetails = useMediaQuery('(min-width: 1180px)')
  const showContactDetails = contactDrawerOpen || (chat.kind === 'direct' && showPersistentDetails)
  const emojiToolRef = useRef<HTMLDivElement>(null)
  const recorder = useRef<MediaRecorder | undefined>(undefined)
  const recordingTimer = useRef<number | undefined>(undefined)
  const recordingCancelledRef = useRef(false)
  const focusTimerRef = useRef<number | undefined>(undefined)
  const nearBottomRef = useRef(true)
  const pendingOwnSendRef = useRef(false)
  const initialScrollPendingRef = useRef(true)
  const initialScrollStableFramesRef = useRef(0)
  const initialScrollAttemptsRef = useRef(0)
  const previousMessagesRef = useRef<MessageDto[]>([])
  const anchorRef = useRef<{ id: string; viewportOffset: number } | undefined>(undefined)
  const pendingHistoryAnchorRef = useRef<{ id: string; viewportOffset: number } | undefined>(undefined)
  const scrollFrameRef = useRef<number | undefined>(undefined)
  const scrollStateFrameRef = useRef<number | undefined>(undefined)
  const rowResizeFrameRef = useRef<number | undefined>(undefined)
  const messageEnterTimersRef = useRef<Map<string, number>>(new Map())
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
  const messageHistoryWasPendingRef = useRef(messageQuery.isPending)
  const messageHistoryReadyFrameRef = useRef<number | undefined>(undefined)
  const [messageHistoryReady, setMessageHistoryReady] = useState(!messageQuery.isPending)
  const [animateMessageHistoryReady, setAnimateMessageHistoryReady] = useState(false)
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
  useEffect(() => {
    if (messageQuery.isPending || messageHistoryReady) return
    if (motionDuration(1) === 0) {
      setMessageHistoryReady(true)
      return
    }
    messageHistoryReadyFrameRef.current = window.requestAnimationFrame(() => {
      messageHistoryReadyFrameRef.current = undefined
      setAnimateMessageHistoryReady(messageHistoryWasPendingRef.current)
      setMessageHistoryReady(true)
    })
    return () => {
      if (messageHistoryReadyFrameRef.current !== undefined) window.cancelAnimationFrame(messageHistoryReadyFrameRef.current)
      messageHistoryReadyFrameRef.current = undefined
    }
  }, [messageHistoryReady, messageQuery.isPending])
  const messageMotionUpdate = (messageQuery.data as (InfiniteData<Page<MessageDto>, string | undefined> & {
    motionUpdate?: { revision: number; quiet: boolean }
  }) | undefined)?.motionUpdate
  const messages = useMemo(() => {
    const unique = new Map<string, MessageDto>()
    const local = [...(messageQuery.data?.pages ?? [])].reverse().flatMap((page) => page.items)
    for (const message of [...remoteHistory, ...local]) unique.set(message.id, message)
    return [...unique.values()].sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
  }, [messageQuery.data, remoteHistory])
  const incomingMessageCount = useMemo(() => messages.reduce((count, message) => count + Number(!message.fromMe), 0), [messages])
  const unreadBoundaryPending = initialUnreadCount > 0 && incomingMessageCount < initialUnreadCount &&
    (messageQuery.isPending || messageQuery.isFetchingNextPage || Boolean(messageQuery.hasNextPage))
  const initialUnreadMessageId = useMemo(() => {
    if (initialUnreadCount <= 0 || unreadBoundaryPending) return undefined
    const incoming = messages.filter((message) => !message.fromMe)
    return incoming.length >= initialUnreadCount ? incoming.at(-initialUnreadCount)?.id : undefined
  }, [initialUnreadCount, messages, unreadBoundaryPending])
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
  useEffect(() => {
    if (initialUnreadCount <= 0 || incomingMessageCount >= initialUnreadCount || !messageQuery.hasNextPage || messageQuery.isFetchingNextPage) return
    void messageQuery.fetchNextPage()
  }, [incomingMessageCount, initialUnreadCount, messageQuery])
  const extractMessageRange = useCallback((range: Range): number[] => {
    const indexes = defaultRangeExtractor(range)
    const pendingId = pendingHistoryAnchorRef.current?.id ?? (initialScrollPendingRef.current ? initialUnreadMessageId : undefined)
    if (!pendingId) return indexes
    const timelineIndex = timeline.findIndex((item) => item.type === 'message' && item.message.id === pendingId)
    const virtualIndex = timelineIndex + 1
    if (timelineIndex < 0 || indexes.includes(virtualIndex)) return indexes
    return [...indexes, virtualIndex].sort((left, right) => left - right)
  }, [initialUnreadMessageId, timeline])
  const virtualizer = useVirtualizer({
    count: timeline.length + 1,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => index === 0 ? 52 : timeline[index - 1]?.type === 'date' ? 38 : 76,
    getItemKey: (index) => index === 0 ? `history-controls:${chat.id}` : timeline[index - 1]?.key ?? `message:${index}`,
    rangeExtractor: extractMessageRange,
    useAnimationFrameWithResizeObserver: true,
    overscan: 8
  })
  const virtualMessageHeight = virtualizer.getTotalSize()
  const virtualMessageOffset = Math.max(0, messageViewportHeight - virtualMessageHeight)
  const captureAnchor = useCallback((): { id: string; viewportOffset: number } | undefined => {
    const element = parentRef.current
    if (!element) return undefined
    const viewport = element.getBoundingClientRect()
    const row = [...element.querySelectorAll<HTMLElement>('.message-item[data-message-id]')]
      .find((candidate) => candidate.getBoundingClientRect().bottom >= viewport.top)
    const id = row?.dataset.messageId
    if (!row || !id) return undefined
    const anchor = { id, viewportOffset: row.getBoundingClientRect().top - viewport.top }
    anchorRef.current = anchor
    return anchor
  }, [])
  const measureRenderedRows = useCallback((): void => {
    const element = parentRef.current
    if (!element) return
    for (const row of element.querySelectorAll<HTMLElement>('.virtual-message[data-index]')) {
      virtualizer.measureElement(row)
    }
  }, [virtualizer])
  const restoreAnchor = useCallback((anchor: { id: string; viewportOffset: number }): void => {
    if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current)
    const index = timeline.findIndex((item) => item.type === 'message' && item.message.id === anchor.id)
    if (index < 0) {
      if (pendingHistoryAnchorRef.current?.id === anchor.id) pendingHistoryAnchorRef.current = undefined
      return
    }
    const alignAnchor = (remainingFrames: number): void => {
      measureRenderedRows()
      const element = parentRef.current
      const row = element && [...element.querySelectorAll<HTMLElement>('.message-item[data-message-id]')]
        .find((candidate) => candidate.dataset.messageId === anchor.id)
      if (element && row) {
        const currentOffset = row.getBoundingClientRect().top - element.getBoundingClientRect().top
        element.scrollTop += currentOffset - anchor.viewportOffset
      } else {
        virtualizer.scrollToIndex(index + 1, { align: 'start' })
      }
      if (remainingFrames > 0) {
        scrollFrameRef.current = requestAnimationFrame(() => alignAnchor(remainingFrames - 1))
        return
      }
      if (pendingHistoryAnchorRef.current?.id === anchor.id) pendingHistoryAnchorRef.current = undefined
      scrollFrameRef.current = undefined
    }
    scrollFrameRef.current = requestAnimationFrame(() => alignAnchor(5))
  }, [measureRenderedRows, timeline, virtualizer])
  const scrollToNewest = useCallback((clearNotice = true): void => {
    if (!messages.length) return
    if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = requestAnimationFrame(() => {
      measureRenderedRows()
      virtualizer.scrollToIndex(timeline.length, { align: 'end' })
      const element = parentRef.current
      if (element) element.scrollTop = element.scrollHeight
      nearBottomRef.current = true
      if (clearNotice) setNewMessageCount(0)
      scrollFrameRef.current = undefined
    })
  }, [measureRenderedRows, messages.length, timeline.length, virtualizer])
  const alignInitialScroll = useCallback((): void => {
    if (!initialScrollPendingRef.current || !messages.length || unreadBoundaryPending) return
    if (scrollFrameRef.current !== undefined) return
    initialScrollStableFramesRef.current = 0
    initialScrollAttemptsRef.current = 0
    const unreadTimelineIndex = initialUnreadMessageId
      ? timeline.findIndex((item) => item.type === 'message' && item.message.id === initialUnreadMessageId)
      : -1
    const align = (): void => {
      if (!initialScrollPendingRef.current) return
      initialScrollAttemptsRef.current += 1
      measureRenderedRows()
      const element = parentRef.current
      let aligned = false
      if (element && unreadTimelineIndex >= 0 && initialUnreadMessageId) {
        const row = [...element.querySelectorAll<HTMLElement>('.message-item[data-message-id]')]
          .find((candidate) => candidate.dataset.messageId === initialUnreadMessageId)
        if (row) {
          const desiredOffset = 48
          const currentOffset = row.getBoundingClientRect().top - element.getBoundingClientRect().top
          element.scrollTop += currentOffset - desiredOffset
          aligned = Math.abs(currentOffset - desiredOffset) <= 2
        } else {
          virtualizer.scrollToIndex(unreadTimelineIndex + 1, { align: 'start' })
        }
        nearBottomRef.current = false
        anchorRef.current = { id: initialUnreadMessageId, viewportOffset: 48 }
      } else if (element) {
        const newestMessageId = messages.at(-1)?.id
        const newestRow = newestMessageId
          ? [...element.querySelectorAll<HTMLElement>('.message-item[data-message-id]')]
            .find((candidate) => candidate.dataset.messageId === newestMessageId)
          : undefined
        virtualizer.scrollToIndex(timeline.length, { align: 'end' })
        element.scrollTop = element.scrollHeight
        aligned = Boolean(newestRow) && element.scrollHeight - element.scrollTop - element.clientHeight <= 2
        nearBottomRef.current = true
      }
      initialScrollStableFramesRef.current = aligned ? initialScrollStableFramesRef.current + 1 : 0
      if (initialScrollStableFramesRef.current < 2 && initialScrollAttemptsRef.current < 60) {
        scrollFrameRef.current = requestAnimationFrame(align)
        return
      }
      initialScrollPendingRef.current = false
      setNewMessageCount(0)
      scrollFrameRef.current = undefined
    }
    scrollFrameRef.current = requestAnimationFrame(align)
  }, [initialUnreadMessageId, measureRenderedRows, messages, timeline, unreadBoundaryPending, virtualizer])
  const handleRowResize = useCallback((): void => {
    if (rowResizeFrameRef.current !== undefined) return
    if (initialScrollPendingRef.current) {
      alignInitialScroll()
      return
    }
    const shouldFollow = nearBottomRef.current
    const anchor = anchorRef.current
    rowResizeFrameRef.current = requestAnimationFrame(() => {
      rowResizeFrameRef.current = undefined
      measureRenderedRows()
      if (shouldFollow) scrollToNewest(false)
      else if (anchor) restoreAnchor(anchor)
    })
  }, [alignInitialScroll, measureRenderedRows, restoreAnchor, scrollToNewest])
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
  const sendMessage = (restrictedContactAcknowledged = false): void => {
    if (chat.readOnly || sendMutation.isPending || session.phase !== 'connected' || (!text.trim() && !attachment)) return
    sendMutation.mutate({ chatId: chat.id, clientId: crypto.randomUUID(), text: text.trim() || undefined,
      attachmentToken: attachment?.token, attachmentKind, quotedMessageId: replyTo?.id, restrictedContactAcknowledged })
  }
  const submitMessage = (): void => {
    if (chat.readOnly || sendMutation.isPending || session.phase !== 'connected' || (!text.trim() && !attachment)) return
    if (chat.crm?.restricted) {
      setEmojiOpen(false)
      setRestrictedSendOpen(true)
      return
    }
    sendMessage()
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
    pendingHistoryAnchorRef.current = undefined
    setConversationMenuOpen(false)
    setContactDrawerOpen(false)
    setSearchOpen(false)
    setMessageSearch('')
    setFocusedMessageId(undefined)
    setEnteringMessageIds(new Set())
    for (const timer of messageEnterTimersRef.current.values()) window.clearTimeout(timer)
    messageEnterTimersRef.current.clear()
    setCrmCapture(undefined)
    setEmojiOpen(false)
    setRestrictedSendOpen(false)
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
    if (!emojiOpen) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!emojiToolRef.current?.contains(event.target as Node)) setEmojiOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setEmojiOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [emojiOpen])

  const insertEmoji = useCallback((emoji: string): void => {
    const textarea = composerRef.current
    const start = textarea?.selectionStart ?? text.length
    const end = textarea?.selectionEnd ?? start
    const nextText = `${text.slice(0, start)}${emoji}${text.slice(end)}`
    const caret = start + emoji.length
    setText(nextText)
    requestAnimationFrame(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionRange(caret, caret)
    })
  }, [text])

  useEffect(() => {
    const element = parentRef.current
    if (!element) return
    const updateScrollState = (): void => {
      if (scrollStateFrameRef.current !== undefined) return
      scrollStateFrameRef.current = requestAnimationFrame(() => {
        scrollStateFrameRef.current = undefined
        if (initialScrollPendingRef.current) return
        nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120
        if (nearBottomRef.current) setNewMessageCount(0)
        captureAnchor()
      })
    }
    updateScrollState()
    element.addEventListener('scroll', updateScrollState, { passive: true })
    const resizeObserver = new ResizeObserver(() => {
      setMessageViewportHeight(element.clientHeight)
      measureRenderedRows()
      if (initialScrollPendingRef.current) alignInitialScroll()
      else if (nearBottomRef.current && messages.length) scrollToNewest(false)
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
  }, [alignInitialScroll, captureAnchor, measureRenderedRows, messages.length, scrollToNewest])

  useLayoutEffect(() => {
    const previous = previousMessagesRef.current
    if (initialScrollPendingRef.current) {
      previousMessagesRef.current = messages
      alignInitialScroll()
      return
    }

    const previousIds = new Set(previous.map((message) => message.id))
    const added = messages.filter((message) => !previousIds.has(message.id))
    const previousNewest = previous.at(-1)
    const newerCount = previousNewest
      ? added.filter((message) => compareMessages(message, previousNewest) > 0).length
      : added.length
    const enteringCandidates = previousNewest ? added.filter((message) => compareMessages(message, previousNewest) > 0) : []
    const entering = !messageMotionUpdate?.quiet && enteringCandidates.length <= 4 && motionDuration(MOTION_MS.slow) > 0
      ? enteringCandidates
      : []
    if (entering.length) {
      setEnteringMessageIds((current) => new Set([...current, ...entering.map((message) => message.id)]))
      for (const message of entering) {
        const existingTimer = messageEnterTimersRef.current.get(message.id)
        if (existingTimer !== undefined) window.clearTimeout(existingTimer)
        const timer = window.setTimeout(() => {
          messageEnterTimersRef.current.delete(message.id)
          setEnteringMessageIds((current) => {
            if (!current.has(message.id)) return current
            const next = new Set(current)
            next.delete(message.id)
            return next
          })
        }, MOTION_MS.slow)
        messageEnterTimersRef.current.set(message.id, timer)
      }
    }
    const historyAnchor = pendingHistoryAnchorRef.current
    const shouldFollow = nearBottomRef.current || pendingOwnSendRef.current

    if (added.length && historyAnchor) {
      restoreAnchor(historyAnchor)
    } else if (added.length && shouldFollow) {
      scrollToNewest()
    } else if (added.length && anchorRef.current) {
      restoreAnchor(anchorRef.current)
      if (newerCount) setNewMessageCount((count) => count + newerCount)
    } else if (newerCount && !shouldFollow) {
      setNewMessageCount((count) => count + newerCount)
    }
    previousMessagesRef.current = messages
  }, [alignInitialScroll, messageMotionUpdate?.quiet, messageMotionUpdate?.revision, messages, restoreAnchor, scrollToNewest, virtualizer])

  useEffect(() => {
    activeRef.current = true
    const messageEnterTimers = messageEnterTimersRef.current
    return () => {
      activeRef.current = false
      if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current)
      if (rowResizeFrameRef.current !== undefined) cancelAnimationFrame(rowResizeFrameRef.current)
      if (focusTimerRef.current !== undefined) window.clearTimeout(focusTimerRef.current)
      if (recordingTimer.current !== undefined) window.clearInterval(recordingTimer.current)
      for (const timer of messageEnterTimers.values()) window.clearTimeout(timer)
      messageEnterTimers.clear()
      if (recorder.current?.state === 'recording') {
        recorder.current.ondataavailable = null
        recorder.current.onstop = null
        recorder.current.stop()
        recorder.current.stream.getTracks().forEach((track) => track.stop())
      }
    }
  }, [])
  useEffect(() => subscribeToReducedMotion(() => {
    for (const timer of messageEnterTimersRef.current.values()) window.clearTimeout(timer)
    messageEnterTimersRef.current.clear()
    setEnteringMessageIds((current) => current.size ? new Set() : current)
    if (!messageQuery.isPending) {
      if (messageHistoryReadyFrameRef.current !== undefined) window.cancelAnimationFrame(messageHistoryReadyFrameRef.current)
      messageHistoryReadyFrameRef.current = undefined
      setAnimateMessageHistoryReady(false)
      setMessageHistoryReady(true)
    }
  }), [messageQuery.isPending])

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
  const revealMessage = useCallback(async (messageId: string): Promise<void> => {
    try {
      if (!messages.some((message) => message.id === messageId)) {
        const context = await window.warish.messages.context(chat.id, messageId, 20)
        setRemoteHistory((current) => mergeMessages(current, context.items))
      }
      setFocusedMessageId(messageId)
      if (focusTimerRef.current !== undefined) window.clearTimeout(focusTimerRef.current)
      focusTimerRef.current = window.setTimeout(() => setFocusedMessageId((current) => current === messageId ? undefined : current), 2_500)
    } catch (error) { pushNotice(errorMessage(error)) }
  }, [chat.id, messages, pushNotice])
  const selectSearchResult = useCallback((message: MessageDto): void => {
    void revealMessage(message.id)
    setSearchOpen(false)
  }, [revealMessage])
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
  const openContactDetails = useCallback((): void => {
    setSearchOpen(false)
    setConversationMenuOpen(false)
    setContactDrawerOpen(true)
  }, [])
  const closeContactDetails = useCallback((): void => {
    setContactDrawerOpen(false)
    requestAnimationFrame(() => composerRef.current?.focus())
  }, [])
  const handleContactArchived = useCallback((): void => {
    setContactDrawerOpen(false)
    onChatHidden()
  }, [onChatHidden])
  const handleJumpToMessage = useCallback((messageId: string): void => {
    setContactDrawerOpen(false)
    void revealMessage(messageId)
  }, [revealMessage])
  const handleAddNote = useCallback((source: MessageDto): void => setCrmCapture({ kind: 'note', message: source }), [])
  const handleAddTask = useCallback((source: MessageDto): void => setCrmCapture({ kind: 'task', message: source }), [])
  const handleOpenQuote = useCallback((messageId: string): void => { void revealMessage(messageId) }, [revealMessage])
  const handleRetryMessage = useCallback((messageId: string): void => {
    void window.warish.messages.retry(messageId).catch((error) => pushNotice(errorMessage(error)))
  }, [pushNotice])
  const handleMessageError = useCallback((error: unknown): void => pushNotice(errorMessage(error)), [pushNotice])
  return <>
    <header className={`conversation-header ${conversationMenuOpen ? 'menu-open' : ''}`}><button className="conversation-identity" title={chat.kind === 'direct' ? 'Open customer details' : 'Open conversation info'} onClick={openContactDetails}><Avatar title={conversationIdentity.primary} src={chat.avatarUrl} /><span title={chat.description}><strong>{conversationIdentity.primary}</strong>{chat.kind === 'direct'
      ? <span className="conversation-crm-line">{chat.crm?.name && chat.crm.name !== conversationIdentity.primary && <span className="conversation-crm-alias">CRM: {chat.crm.name}</span>}
        {conversationIdentity.profileName && <span className="whatsapp-profile-pill">{conversationIdentity.profileName}</span>}</span>
      : <span>{chatSubtitle(chat)}</span>}</span></button>
      {chat.kind === 'direct' && <CustomerSummaryStrip chat={chat} onOpenDetails={openContactDetails} />}
      <Tooltip label="Search this conversation"><button className={`icon-button ${searchOpen ? 'active' : ''}`}
        aria-label="Search this conversation" aria-expanded={searchOpen}
        onClick={() => { setConversationMenuOpen(false); setContactDrawerOpen(false); setSearchOpen((open) => !open) }}><Search /></button></Tooltip>
      <DropdownMenu label="Conversation menu" icon={<Menu />} isOpen={conversationMenuOpen}
        onOpenChange={(open) => { if (open) { setSearchOpen(false); setContactDrawerOpen(false) }; setConversationMenuOpen(open) }} items={[
          { id: 'pin', label: chat.pinned ? 'Unpin chat' : 'Pin chat', icon: chat.pinned ? <PinOff /> : <Pin />,
            disabled: chatAction.isPending, onAction: () => chatAction.mutate({ patch: { pinned: !chat.pinned } }) },
          { id: 'read', label: 'Mark as read', icon: <CheckCheck />,
            onAction: () => { void window.warish.chats.markRead(chat.id).catch((error) => pushNotice(errorMessage(error))) } },
          { id: 'archive', label: chat.archived ? 'Unarchive chat' : 'Archive chat',
            icon: chat.archived ? <ArchiveRestore /> : <Archive />, disabled: chatAction.isPending,
            onAction: () => chatAction.mutate({ patch: { archived: !chat.archived }, hide: true }) }
        ]} />
    </header>
    {chat.kind === 'direct' && <SalesLifecyclePath chat={chat} />}
    <div className="message-scroller" ref={parentRef}>
      {messageQuery.isError && <QueryError label="Could not load messages" onRetry={() => void messageQuery.refetch()} />}
      {!messageHistoryReady && <MessageHistorySkeleton />}
      <div className={`virtual-message-list ${animateMessageHistoryReady ? 'message-history-ready' : ''}`}
        aria-hidden={!messageHistoryReady || undefined} style={{ height: Math.max(virtualMessageHeight, messageViewportHeight) }}>
        {virtualizer.getVirtualItems().map((item) => {
          if (item.index === 0) return <div key={String(item.key)} ref={virtualizer.measureElement} data-index={item.index} className="virtual-message history-controls" style={{ transform: `translateY(${item.start + virtualMessageOffset}px)` }}>
            {messageQuery.hasNextPage
              ? <button className="load-older" onClick={() => { pendingHistoryAnchorRef.current = captureAnchor(); void messageQuery.fetchNextPage() }}>{messageQuery.isFetchingNextPage ? <LoaderCircle className="spin" /> : <ArrowUp />} Load older messages</button>
              : !chat.readOnly && remoteHasMore && messages.length > 0
                ? <button className="load-older" disabled={earlierMutation.isPending} onClick={() => { pendingHistoryAnchorRef.current = captureAnchor(); earlierMutation.mutate() }}>{earlierMutation.isPending ? <LoaderCircle className="spin" /> : <ArrowUp />} {earlierMutation.isPending ? 'Requesting earlier messages…' : 'Load earlier messages from phone'}</button>
                : messages.length > 0 && <div className="history-start">Beginning of available conversation</div>}
          </div>
          const timelineItem = timeline[item.index - 1]!
          if (timelineItem.type === 'date') return <div key={String(item.key)} ref={virtualizer.measureElement} data-index={item.index}
            className="virtual-message date-separator-row" style={{ transform: `translateY(${item.start + virtualMessageOffset}px)` }}><div className="date-separator">{timelineItem.label}</div></div>
          const message = timelineItem.message
          const groupPosition = groupPositionById.get(message.id) ?? 'single'
          return <div key={String(item.key)} ref={virtualizer.measureElement} data-index={item.index} data-message-id={message.id}
            className={`virtual-message message-item group-${groupPosition} ${message.id === focusedMessageId ? 'search-target' : ''} ${enteringMessageIds.has(message.id) ? 'message-enter' : ''}`} style={{ transform: `translateY(${item.start + virtualMessageOffset}px)` }}>
            <MessageBubble message={message} groupPosition={groupPosition} readOnly={chat.readOnly} showSender={showSenderById.get(message.id) ?? false} onReply={setReplyTo} onForward={onForward}
              onAddNote={chat.kind === 'direct' ? handleAddNote : undefined}
              onAddTask={chat.kind === 'direct' ? handleAddTask : undefined}
              onOpenQuote={handleOpenQuote} onResize={handleRowResize}
              onRetry={handleRetryMessage} onError={handleMessageError} />
          </div>
        })}
      </div>
    </div>
    <MotionPresence show={searchOpen}>{searchOpen && <aside className="conversation-search-panel">
      <header><strong>Search messages</strong><Tooltip label="Close search"><button className="icon-button" aria-label="Close search"
        onClick={() => setSearchOpen(false)}><X /></button></Tooltip></header>
      <label className="search-box conversation-search-box"><Search /><input autoFocus value={messageSearch} onChange={(event) => setMessageSearch(event.target.value)} placeholder="Search this conversation" />{messageSearch && <IconButton className="" label="Clear message search" onClick={() => setMessageSearch('')}><X /></IconButton>}</label>
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
    </aside>}</MotionPresence>
    <MotionPresence show={showContactDetails}>{showContactDetails && <Suspense fallback={<aside className={`${chat.kind === 'direct' ? 'crm-contact-panel in-conversation persistent-contact-panel' : 'contact-drawer'} ${contactDrawerOpen ? 'details-overlay-open' : ''}`}><LoadingRow label="Loading customer details…" /></aside>}><ContactDrawer chat={chat}
      persistent={chat.kind === 'direct'} overlayOpen={contactDrawerOpen} onClose={closeContactDetails}
      onArchived={handleContactArchived} onJumpToMessage={handleJumpToMessage} /></Suspense>}</MotionPresence>
    <MotionPresence show={Boolean(crmCapture)}>{crmCapture && <CrmCaptureDialog chat={chat} capture={crmCapture} onClose={() => setCrmCapture(undefined)} />}</MotionPresence>
    <MotionPresence show={restrictedSendOpen}>{restrictedSendOpen && <ConfirmationDialog title="Send to a restricted contact?"
      description={`${chat.crm?.name ?? chat.title} is marked as restricted in CRM. Confirm that you intend to start this conversation.`}
      confirmLabel="Send message" pending={sendMutation.isPending} onClose={() => setRestrictedSendOpen(false)} onConfirm={() => {
        setRestrictedSendOpen(false)
        sendMessage(true)
      }} />}</MotionPresence>
    {newMessageCount > 0 && <button className="new-messages-button" onClick={() => scrollToNewest()}><ArrowDown />{newMessageCount} new {newMessageCount === 1 ? 'message' : 'messages'}</button>}
    {!chat.readOnly && (replyTo || attachment) && <div className="composer-context">
      <div>{replyTo && <><strong>Replying to {replyTo.senderName ?? (replyTo.fromMe ? 'yourself' : chat.title)}</strong><span>{replyTo.text ?? replyTo.kind}</span></>}{attachment && <><strong>{attachmentKind === 'voice' ? 'Voice message' : attachment.name}</strong><span>{formatBytes(attachment.size)}</span></>}</div>
      <IconButton className="" label="Clear reply or attachment" onClick={() => {
        setReplyTo(undefined)
        if (attachment) void window.warish.media.discardDraft(attachment.token)
        setAttachment(undefined)
        setAttachmentKind(undefined)
      }}><X /></IconButton>
    </div>}
    {chat.readOnly ? <footer className="read-only-composer"><Radio /><span>Channels are read-only in WArish</span></footer> : <footer className="composer">
      <div className="composer-tool" ref={emojiToolRef}><Tooltip label="Emoji"><button className={`icon-button ${emojiOpen ? 'active' : ''}`}
        aria-label="Choose an emoji" aria-haspopup="dialog" aria-expanded={emojiOpen} disabled={isRecording}
        onClick={() => setEmojiOpen((open) => !open)}><Smile /></button></Tooltip>
        <MotionPresence show={emojiOpen}>{emojiOpen && <EmojiPicker onSelect={insertEmoji} onClose={() => setEmojiOpen(false)} />}</MotionPresence></div>
      <Tooltip label="Attach a file"><button className="icon-button" aria-label="Attach a file" disabled={isRecording}
        onClick={() => void chooseAttachment()}><Paperclip /></button></Tooltip>
      <textarea ref={composerRef} value={text} rows={1} aria-label="Message" placeholder={isRecording ? `Recording… ${formatDuration(recordingSeconds)}` : session.phase === 'connected' ? 'Type a message' : 'Type a draft — reconnect to send'} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
        if (shouldSubmitComposer(event, enterToSend)) { event.preventDefault(); submitMessage() }
      }} />
      {isRecording ? <><Tooltip label="Cancel recording"><button className="icon-button recording" aria-label="Cancel recording"
        onClick={() => stopRecording(true)}><X /></button></Tooltip>
        <Tooltip label="Finish recording"><button className="send-button" aria-label="Finish recording"
          onClick={() => stopRecording(false)}><Square /></button></Tooltip></>
        : !text.trim() && !attachment ? <Tooltip label="Voice message"><button className="icon-button" aria-label="Record a voice message"
          onClick={() => void toggleRecording()}><Mic /></button></Tooltip>
          : <Tooltip label={session.phase === 'connected' ? 'Send' : 'Reconnect to send'}><button className="send-button" aria-label="Send message"
            disabled={sendMutation.isPending || session.phase !== 'connected'} onClick={submitMessage}>{sendMutation.isPending ? <LoaderCircle className="spin" /> : <Send />}</button></Tooltip>}
    </footer>}
  </>
}

function EmojiPicker({ onSelect, onClose }: { onSelect(emoji: string): void; onClose(): void }): React.JSX.Element {
  const moveFocus = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const offsets: Partial<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
    const offset = offsets[event.key]
    if (offset === undefined) return
    event.preventDefault()
    const next = (index + offset + COMPOSER_EMOJIS.length) % COMPOSER_EMOJIS.length
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')
    buttons?.[next]?.focus()
  }
  return <div className="emoji-picker" role="dialog" aria-label="Choose an emoji">
    <header><strong>Emoji</strong><IconButton className="" label="Close emoji picker" onClick={onClose}><X /></IconButton></header>
    <div className="emoji-grid">{COMPOSER_EMOJIS.map(([emoji, label], index) => <Tooltip key={emoji} label={label}><button aria-label={label}
      onMouseDown={(event) => event.preventDefault()} onKeyDown={(event) => moveFocus(event, index)} onClick={() => onSelect(emoji)}>{emoji}</button></Tooltip>)}</div>
  </div>
}

function ConfirmationDialog({ title, description, confirmLabel, pending = false, onConfirm, onClose }: {
  title: string
  description: string
  confirmLabel: string
  pending?: boolean
  onConfirm(): void
  onClose(): void
}): React.JSX.Element {
  const dialogRef = useDialogFocus<HTMLElement>(onClose, !pending)
  return <div className="modal-backdrop confirmation-backdrop" onMouseDown={(event) => {
    if (!pending && event.target === event.currentTarget) onClose()
  }}><section ref={dialogRef} className="modal action-dialog confirmation-dialog" role="alertdialog" aria-modal="true"
    aria-label={title} tabIndex={-1}>
    <header><div className="dialog-icon warning"><CircleAlert /></div><h2>{title}</h2>
      <IconButton label="Cancel" disabled={pending} onClick={onClose}><X /></IconButton></header>
    <div className="action-dialog-content"><p>{description}</p><footer><button disabled={pending} onClick={onClose}>Cancel</button>
      <button className="primary-button" disabled={pending} onClick={onConfirm}>{pending ? 'Working…' : confirmLabel}</button></footer></div>
  </section></div>
}

function CrmCaptureDialog({ chat, capture, onClose }: {
  chat: ChatSummary
  capture: { kind: 'note' | 'task'; message: MessageDto }
  onClose(): void
}): React.JSX.Element {
  const preview = messagePreview(capture.message)
  const dialogRef = useDialogFocus<HTMLElement>(onClose)
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
  }, onSuccess: (result) => {
    const crmRefreshes = [
      queryClient.invalidateQueries({ queryKey: ['crm', 'contact', result.contactId] }),
      queryClient.invalidateQueries({ queryKey: ['crm', 'activity', result.contactId] }),
      queryClient.invalidateQueries({ queryKey: ['crm', 'contacts'] }),
      queryClient.invalidateQueries({ queryKey: ['crm', 'dashboard'] })
    ]
    crmRefreshes.push(queryClient.invalidateQueries({
      queryKey: capture.kind === 'note' ? ['crm', 'notes', result.contactId] : ['crm', 'tasks']
    }))
    void Promise.all(crmRefreshes)
    void queryClient.invalidateQueries({ queryKey: ['chats'] })
    pushNotice(capture.kind === 'note' ? 'Message added to CRM notes' : 'Follow-up task created', 'info')
    onClose()
  }, onError: (error) => pushNotice(errorMessage(error)) })
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section ref={dialogRef}
    className="modal crm-capture-dialog" role="dialog" aria-modal="true" tabIndex={-1}
    aria-label={capture.kind === 'note' ? 'Add CRM note' : 'Create follow-up task'}>
    <header><div><span>{capture.kind === 'note' ? 'CRM note' : 'Follow-up task'}</span><h2>{capture.kind === 'note' ? 'Add message to notes' : 'Create task from message'}</h2></div>
      <IconButton label="Close" onClick={onClose}><X /></IconButton></header>
    <form onSubmit={(event) => { event.preventDefault(); save.mutate() }}><div className="crm-capture-source"><MessageCircle /><span><small>{capture.message.fromMe ? 'You' : capture.message.senderName ?? chat.title}</small><strong>{preview}</strong></span></div>
      {capture.kind === 'note' ? <label><span>Note</span><textarea autoFocus value={body} onChange={(event) => setBody(event.target.value)} required /></label>
        : <><label><span>Task</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
          <label><span>Notes</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <div className="form-grid"><label><span>Due</span><input type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} /></label>
            <SelectField className="form-field" label="Priority" value={priority}
              onChange={(value) => setPriority(value as CrmTaskDto['priority'])} options={[
                { value: 'low', label: 'Low' }, { value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }
              ]} /></div></>}
      <footer><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button"
        disabled={save.isPending || (capture.kind === 'note' ? !body.trim() : !title.trim())}>{save.isPending ? 'Saving…' : capture.kind === 'note' ? <><NotebookPen />Add note</> : <><ListTodo />Create task</>}</button></footer>
    </form>
  </section></div>
}

function ForwardDialog({ message, onClose }: { message: MessageDto; onClose(): void }): React.JSX.Element {
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [restrictedConfirmation, setRestrictedConfirmation] = useState<{ ids: string[]; names: string[] }>()
  const dialogRef = useDialogFocus<HTMLElement>(onClose)
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
    if (restricted.length) {
      setRestrictedConfirmation({ ids: restricted.map((chat) => chat.id), names: restricted.map((chat) => chat.crm?.name ?? chat.title) })
      return
    }
    mutation.mutate(restricted.map((chat) => chat.id))
  }
  return <><div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section ref={dialogRef}
    className="modal forward-dialog" role="dialog" aria-modal="true" aria-labelledby="forward-title" tabIndex={-1}><header><h2 id="forward-title">Forward message</h2>
      <IconButton label="Close forward dialog" onClick={onClose}><X /></IconButton></header>
    <label className="search-box"><Search /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" />
      {query && <IconButton className="" label="Clear search" onClick={() => setQuery('')}><X /></IconButton>}</label>
    <div className="forward-list" onScroll={(event) => {
      const element = event.currentTarget
      if (element.scrollHeight - element.scrollTop - element.clientHeight < 180 && chatsQuery.hasNextPage && !chatsQuery.isFetchingNextPage) void chatsQuery.fetchNextPage()
    }}>
      {chatsQuery.isPending && <LoadingRow label="Loading conversations…" />}
      {chatsQuery.isError && <QueryError label="Could not load conversations" onRetry={() => void chatsQuery.refetch()} />}
      {chats.map((chat) => <label key={chat.id}><input type="checkbox" checked={selected.includes(chat.id)} onChange={() => setSelected((items) => items.includes(chat.id) ? items.filter((id) => id !== chat.id) : [...items, chat.id])} /><Avatar title={chat.title} src={chat.avatarUrl} /><span>{chat.title}</span>{selected.includes(chat.id) && <Check />}</label>)}
      {chatsQuery.isFetchingNextPage && <LoadingRow label="Loading more conversations…" />}
    </div><footer><button onClick={onClose}>Cancel</button><button className="primary-button" disabled={!selected.length || mutation.isPending} onClick={submitForward}>{mutation.isPending ? 'Forwarding…' : 'Forward'}</button></footer></section></div>
    <MotionPresence show={Boolean(restrictedConfirmation)}>{restrictedConfirmation && <ConfirmationDialog title="Forward to restricted contacts?"
      description={`${restrictedConfirmation.names.join(', ')} ${restrictedConfirmation.names.length === 1 ? 'is' : 'are'} marked as restricted in CRM.`}
      confirmLabel="Forward anyway" onClose={() => setRestrictedConfirmation(undefined)} onConfirm={() => {
        mutation.mutate(restrictedConfirmation.ids)
        setRestrictedConfirmation(undefined)
      }} />}</MotionPresence></>
}

function WelcomePanel(): React.JSX.Element { return <div className="welcome-panel"><MessageCircle /><h2>No conversation selected</h2></div> }
function LoadingRow({ label }: { label: string }): React.JSX.Element { return <div className="loading-row"><LoaderCircle className="spin" />{label}</div> }
function SkeletonRows(): React.JSX.Element {
  return <div className="skeleton-list" aria-label="Loading conversations">{Array.from({ length: 8 }, (_, index) =>
    <div className="skeleton-row" key={index}><i /><span><b /><b /></span></div>)}</div>
}
function MessageHistorySkeleton(): React.JSX.Element {
  return <div className="message-history-skeleton" aria-label="Loading messages">{Array.from({ length: 6 }, (_, index) =>
    <div className={index % 3 === 1 ? 'mine' : ''} key={index}><i /><span /></div>)}</div>
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
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const update = (): void => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}

function formatBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB` }
