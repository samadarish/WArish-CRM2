// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, ChatSummary, MessageDto, SessionState } from '../src/shared/contracts'
import { ChatShell } from '../src/renderer/src/components/ChatShell'
import { useUiStore } from '../src/renderer/src/store'

const chat: ChatSummary = {
  id: 'composer-focus@g.us', title: 'Composer focus', kind: 'group', unreadCount: 0, archived: false, pinned: false
}

const settings: AppSettings = {
  theme: 'system', density: 'dense', notificationPreview: true, enterToSend: true, showChatPreviews: true,
  reduceMotion: false, conversationBackground: 'subtle', cacheLimitBytes: 512 * 1024 * 1024,
  launchAtLogin: false, historySyncDays: 30, navigationMode: 'expanded'
}

const session: SessionState = { phase: 'connected', accountState: 'linked' }

beforeEach(() => {
  class ResizeObserverStub {
    observe(): void { /* Layout is not measured in jsdom. */ }
    unobserve(): void { /* Layout is not measured in jsdom. */ }
    disconnect(): void { /* Layout is not measured in jsdom. */ }
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  } satisfies MediaQueryList)))
  useUiStore.setState({ destination: 'group', selectedChatId: chat.id, chatStageFilter: 'all', settingsOpen: false, notices: [] })
})

afterEach(() => {
  cleanup()
  useUiStore.setState({ destination: 'direct', selectedChatId: undefined, chatStageFilter: 'all', settingsOpen: false, notices: [] })
  Reflect.deleteProperty(window, 'warish')
  vi.unstubAllGlobals()
})

describe('chat composer focus', () => {
  it('waits for printable typing before focusing from the central conversation pane', async () => {
    installChatApi(vi.fn().mockRejectedValue(new Error('Not sent in this test')))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    queryClient.setQueryData(['draft', chat.id], { chatId: chat.id, text: '', attachments: [], updatedAt: Date.now() })
    render(<QueryClientProvider client={queryClient}><ChatShell session={session} /></QueryClientProvider>)

    const composer = await screen.findByRole('textbox', { name: 'Message' })
    const conversationHeader = document.querySelector<HTMLElement>('.conversation-header')!
    const messageScroller = document.querySelector<HTMLElement>('.message-scroller')!
    const chatList = document.querySelector<HTMLElement>('.chat-list-panel')!

    fireEvent.pointerDown(conversationHeader)
    expect(composer).not.toHaveFocus()
    fireEvent.focusIn(document.body)
    fireEvent.keyDown(window, { key: 'h' })
    expect(composer).toHaveFocus()

    composer.blur()
    fireEvent.pointerDown(chatList)
    fireEvent.keyDown(window, { key: 'x' })
    expect(composer).not.toHaveFocus()

    fireEvent.wheel(messageScroller)
    expect(composer).not.toHaveFocus()
    fireEvent.keyDown(window, { key: 'w' })
    expect(composer).toHaveFocus()

    composer.blur()
    fireEvent.click(screen.getByRole('button', { name: 'Search this conversation' }))
    await screen.findByPlaceholderText('Search this conversation')
    fireEvent.pointerDown(messageScroller)
    fireEvent.keyDown(window, { key: 'q' })
    expect(composer).not.toHaveFocus()
  })

  it('stays focused and accepts more typing after an Enter send settles', async () => {
    let settleSend: ((message: MessageDto) => void) | undefined
    const send = vi.fn(() => new Promise<MessageDto>((resolve) => { settleSend = resolve }))
    installChatApi(send)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    queryClient.setQueryData(['draft', chat.id], { chatId: chat.id, text: '', attachments: [], updatedAt: Date.now() })
    render(<QueryClientProvider client={queryClient}><ChatShell session={session} /></QueryClientProvider>)

    const composer = await screen.findByRole('textbox', { name: 'Message' })
    composer.focus()
    fireEvent.change(composer, { target: { value: 'First message' } })
    expect(composer).toHaveValue('First message')
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(send).toHaveBeenCalledOnce())
    expect(composer).toHaveFocus()
    expect(composer).toHaveAttribute('readonly')
    expect(composer).toHaveAttribute('aria-busy', 'true')

    settleSend?.({
      id: 'sent-message', chatId: chat.id, fromMe: true, kind: 'text', text: 'First message', timestamp: Date.now(),
      status: 'sent', edited: false, deleted: false, reactions: []
    })

    await waitFor(() => expect(composer).not.toHaveAttribute('readonly'))
    expect(composer).toHaveAttribute('aria-busy', 'false')
    expect(composer).toHaveFocus()
    fireEvent.change(composer, { target: { value: 'Second message' } })
    expect(composer).toHaveValue('Second message')
  })
})

function installChatApi(send: () => Promise<MessageDto>): void {
  Object.defineProperty(window, 'warish', { configurable: true, value: {
    settings: { get: vi.fn().mockResolvedValue(settings), update: vi.fn() },
    chats: {
      list: vi.fn().mockResolvedValue({ items: [chat] }),
      get: vi.fn().mockResolvedValue(chat),
      markRead: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined)
    },
    contacts: { hydrate: vi.fn().mockResolvedValue(undefined) },
    messages: {
      list: vi.fn().mockResolvedValue({ items: [] }),
      send,
      loadEarlier: vi.fn().mockResolvedValue({ items: [], hasMore: false })
    },
    drafts: {
      get: vi.fn().mockResolvedValue({ chatId: chat.id, text: '', attachments: [], updatedAt: Date.now() }),
      save: vi.fn().mockResolvedValue(undefined)
    }
  } })
}
