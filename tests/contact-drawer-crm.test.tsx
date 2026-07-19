// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatSummary, ContactDetails, CrmContactDetailsDto, CrmNoteDto, CrmStageDto } from '../src/shared/contracts'
import { ContactDrawer } from '../src/renderer/src/components/ContactDrawer'

const chat: ChatSummary = {
  id: '919876543210@s.whatsapp.net', title: '+91 98765 43210', kind: 'direct', whatsappName: 'Priya WA',
  phoneNumber: '+919876543210', unreadCount: 0, archived: false, pinned: false
}
const details: ContactDetails = {
  chatId: chat.id, kind: 'direct', title: chat.title, whatsappName: chat.whatsappName, phoneNumber: chat.phoneNumber,
  pinned: false, archived: false
}
const stages: CrmStageDto[] = [
  { id: 'stage-new', key: 'new', name: 'New enquiry', color: '#0ea5a4', position: 0, outcome: 'open' }
]
const contact: CrmContactDetailsDto = {
  id: 'crm-1', identityId: 'identity-1', chatId: chat.id, lifecycle: 'lead', stageId: 'stage-new', stageKey: 'new',
  stageName: 'New enquiry', stageColor: '#0ea5a4', name: 'Priya CRM', whatsappName: 'Priya WA',
  phoneNumber: '+919876543210', source: 'manual', tags: [], createdAt: Date.now(), lastActivityAt: Date.now(),
  orderCount: 0, lifetimeValue: 0, openTaskCount: 0, googleLinked: false, consentStatus: 'unknown',
  doNotContact: false, customFields: {}
}
const linkedNote: CrmNoteDto = {
  id: 'note-1', contactId: contact.id, body: 'Customer asked for a revised quote', sourceMessageId: 'message-1',
  sourceMessage: { messageId: 'message-1', chatId: chat.id, senderName: 'Priya WA', fromMe: false, kind: 'text',
    text: 'Please revise the quote', timestamp: Date.now() - 60_000 }, createdAt: Date.now(), updatedAt: Date.now()
}

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'warish')
})

describe('direct-chat CRM drawer', () => {
  it('creates the CRM record only on mutation and retains source-message navigation', async () => {
    const ensure = vi.fn().mockResolvedValue(contact)
    const getCrmContact = vi.fn().mockRejectedValueOnce(new Error('CRM contact not found')).mockResolvedValue(contact)
    Object.defineProperty(window, 'warish', { configurable: true, value: {
      contacts: { get: vi.fn().mockResolvedValue(details) },
      chats: { update: vi.fn().mockResolvedValue(undefined) },
      crm: {
        pipeline: vi.fn().mockResolvedValue(stages),
        contacts: { get: getCrmContact, ensure, update: vi.fn(), setStage: vi.fn().mockResolvedValue(contact) },
        notes: { list: vi.fn().mockResolvedValue([linkedNote]), save: vi.fn(), add: vi.fn(), delete: vi.fn() },
        tasks: { list: vi.fn().mockResolvedValue([]), save: vi.fn(), delete: vi.fn() },
        orders: { list: vi.fn().mockResolvedValue([]), get: vi.fn(), save: vi.fn(), delete: vi.fn() },
        catalog: { list: vi.fn().mockResolvedValue([]) }, activity: vi.fn().mockResolvedValue([])
      },
      google: { status: vi.fn().mockResolvedValue({ configured: false, connected: false }) }
    } })
    const onJumpToMessage = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><ContactDrawer chat={chat} onClose={vi.fn()} onArchived={vi.fn()}
      onJumpToMessage={onJumpToMessage} /></QueryClientProvider>)

    expect(await screen.findByText('Not tracked in CRM')).toBeInTheDocument()
    expect(ensure).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Add to CRM' }))
    await waitFor(() => expect(ensure).toHaveBeenCalledOnce())
    expect((await screen.findAllByText('Priya CRM')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'notes' }))
    expect(await screen.findByText('Please revise the quote')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show source message' }))
    expect(onJumpToMessage).toHaveBeenCalledWith('message-1')
  })
})
