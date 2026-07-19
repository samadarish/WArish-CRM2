// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatSummary, ContactDetails, CrmContactDetailsDto, CrmNoteDto, CrmStageDto } from '../src/shared/contracts'
import { ContactDrawer } from '../src/renderer/src/components/ContactDrawer'

const chat: ChatSummary = {
  id: '919876543210@s.whatsapp.net', title: '+91 98765 43210', kind: 'direct', whatsappName: 'Priya WA',
  phoneNumber: '+919876543210', avatarUrl: 'data:image/png;base64,iVBORw0KGgo=', unreadCount: 0, archived: false, pinned: false
}
const details: ContactDetails = {
  chatId: chat.id, kind: 'direct', title: chat.title, whatsappName: chat.whatsappName, phoneNumber: chat.phoneNumber,
  avatarUrl: chat.avatarUrl, pinned: false, archived: false
}
const stages: CrmStageDto[] = [
  { id: 'stage-new', key: 'new', name: 'New enquiry', color: '#0ea5a4', position: 0, outcome: 'open' }
]
const contact: CrmContactDetailsDto = {
  id: 'crm-1', identityId: 'identity-1', chatId: chat.id, lifecycle: 'lead', stageId: 'stage-new', stageKey: 'new',
  stageName: 'New enquiry', stageColor: '#0ea5a4', name: 'Priya CRM', whatsappName: 'Priya WA',
  phoneNumber: '+919876543210', avatarUrl: chat.avatarUrl, source: 'manual', tags: [], createdAt: Date.now(), lastActivityAt: Date.now(),
  orderCount: 0, lifetimeValue: 0, openTaskCount: 0, consentStatus: 'unknown',
  doNotContact: false, customFields: {}
}
const linkedNote: CrmNoteDto = {
  id: 'note-1', contactId: contact.id, body: 'Customer asked for a revised quote', sourceMessageId: 'message-1',
  sourceMessage: { messageId: 'message-1', chatId: chat.id, senderName: 'Priya WA', fromMe: false, kind: 'text',
    text: 'Please revise the quote', timestamp: Date.now() - 60_000 }, createdAt: Date.now(), updatedAt: Date.now()
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'warish')
})

describe('direct-chat CRM drawer', () => {
  it('creates the CRM record only on mutation and retains source-message navigation', async () => {
    const ensure = vi.fn().mockResolvedValue(contact)
    const saveContact = vi.fn().mockResolvedValue({ ...details, savedName: 'Priya Saved', title: 'Priya Saved' })
    const getCrmContact = vi.fn().mockRejectedValueOnce(new Error('CRM contact not found')).mockResolvedValue(contact)
    Object.defineProperty(window, 'warish', { configurable: true, value: {
      contacts: { get: vi.fn().mockResolvedValue(details), save: saveContact },
      session: { getState: vi.fn().mockResolvedValue({ phase: 'connected', accountState: 'linked' }) },
      chats: { update: vi.fn().mockResolvedValue(undefined) },
      crm: {
        pipeline: vi.fn().mockResolvedValue(stages),
        contacts: { get: getCrmContact, ensure, update: vi.fn(), setStage: vi.fn().mockResolvedValue(contact) },
        notes: { list: vi.fn().mockResolvedValue([linkedNote]), save: vi.fn(), add: vi.fn(), delete: vi.fn() },
        tasks: { list: vi.fn().mockResolvedValue([]), save: vi.fn(), delete: vi.fn() },
        orders: { list: vi.fn().mockResolvedValue([]), get: vi.fn(), save: vi.fn(), delete: vi.fn() },
        catalog: { list: vi.fn().mockResolvedValue([]) }, activity: vi.fn().mockResolvedValue([])
      }
    } })
    const onJumpToMessage = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><ContactDrawer chat={chat} onClose={vi.fn()} onArchived={vi.fn()}
      onJumpToMessage={onJumpToMessage} persistent overlayOpen /></QueryClientProvider>)

    expect(await screen.findByText('Not tracked in CRM')).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'CRM contact record' })).toHaveClass('persistent-contact-panel', 'details-overlay-open')
    expect(ensure).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Add to CRM' }))
    await waitFor(() => expect(ensure).toHaveBeenCalledOnce())
    expect((await screen.findAllByText('Priya CRM')).length).toBeGreaterThan(0)
    expect(document.querySelector('.crm-contact-hero .avatar.large img')).toBeInTheDocument()
    expect(screen.queryByText('Pipeline stage')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save contact' }))
    const name = await screen.findByRole('textbox', { name: 'Contact name' })
    fireEvent.change(name, { target: { value: 'Priya Saved' } })
    const contactDialog = screen.getByRole('dialog', { name: 'Save new contact' })
    fireEvent.click(within(contactDialog).getByRole('button', { name: 'Save contact' }))
    await waitFor(() => expect(saveContact).toHaveBeenCalledWith(chat.id, { fullName: 'Priya Saved' }))

    fireEvent.click(screen.getByRole('button', { name: 'notes' }))
    expect(await screen.findByText('Please revise the quote')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show source message' }))
    expect(onJumpToMessage).toHaveBeenCalledWith('message-1')
  })

  it('keeps WhatsApp contact saving unavailable while disconnected', async () => {
    Object.defineProperty(window, 'warish', { configurable: true, value: {
      contacts: { get: vi.fn().mockResolvedValue(details), save: vi.fn() },
      session: { getState: vi.fn().mockResolvedValue({ phase: 'offline', accountState: 'linked' }) },
      chats: { update: vi.fn() },
      crm: { pipeline: vi.fn().mockResolvedValue(stages), contacts: { get: vi.fn().mockRejectedValue(new Error('Not tracked')), ensure: vi.fn() } }
    } })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><ContactDrawer chat={chat} onClose={vi.fn()} onArchived={vi.fn()} /></QueryClientProvider>)
    expect(await screen.findByRole('button', { name: 'Save contact' })).toBeDisabled()
  })
})
