// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrmContactDetailsDto, CrmContactSummaryDto, CrmDashboardDto, CrmStageDto } from '../src/shared/contracts'
import { CrmShell } from '../src/renderer/src/components/CrmShell'
import { useUiStore } from '../src/renderer/src/store'

const stages: CrmStageDto[] = [
  { id: 'stage-new', key: 'new', name: 'New enquiry', color: '#F59E0B', position: 0, outcome: 'open' },
  { id: 'stage-qualified', key: 'qualified', name: 'Qualified', color: '#EAB308', position: 1, outcome: 'open' },
  { id: 'stage-quoted', key: 'quoted', name: 'Quoted', color: '#8B5CF6', position: 2, outcome: 'open' },
  { id: 'stage-won', key: 'won', name: 'Won', color: '#84CC16', position: 3, outcome: 'won' },
  { id: 'stage-lost', key: 'lost', name: 'Lost', color: '#EF4444', position: 4, outcome: 'lost' }
]
const contact: CrmContactSummaryDto = {
  id: 'crm-1', identityId: 'identity-1', chatId: 'chat-1', lifecycle: 'lead', stageId: 'stage-new', stageKey: 'new',
  stageName: 'New enquiry', stageColor: '#F59E0B', name: 'Priya Enquiry', whatsappName: 'Priya WA',
  phoneNumber: '+919876543210', company: 'Priya Studio', source: 'whatsapp', tags: [], createdAt: Date.now() - 60_000,
  lastActivityAt: Date.now(), orderCount: 0, lifetimeValue: 0, openTaskCount: 1
}
const wonContact: CrmContactSummaryDto = { ...contact, id: 'crm-won', identityId: 'identity-won', chatId: 'chat-won',
  lifecycle: 'customer', stageId: 'stage-won', stageKey: 'won', stageName: 'Won', stageColor: '#84CC16', name: 'Won Customer' }
const lostContact: CrmContactSummaryDto = { ...contact, id: 'crm-lost', identityId: 'identity-lost', chatId: 'chat-lost',
  lifecycle: 'customer', stageId: 'stage-lost', stageKey: 'lost', stageName: 'Lost', stageColor: '#EF4444', name: 'Lost Customer' }
const details: CrmContactDetailsDto = { ...contact, consentStatus: 'unknown', doNotContact: false, customFields: {} }
const dashboard: CrmDashboardDto = { newLeads: 1, openLeads: 1, customers: 0, overdueTasks: 1, ordersThisMonth: 0,
  revenueThisMonth: 0, lifetimeRevenue: 0, recentContacts: [contact], pipeline: stages.map((stage) => ({ ...stage,
    count: stage.key === 'new' ? 1 : 0, value: 0 })) }

function mockApi(): Record<string, unknown> {
  const listContacts = vi.fn((input: { lifecycle?: string; stageId?: string } = {}) => {
    if (input.lifecycle === 'active' && input.stageId === 'stage-won') return Promise.resolve([wonContact])
    if (input.lifecycle === 'active' && input.stageId === 'stage-lost') return Promise.resolve([lostContact])
    return Promise.resolve([contact])
  })
  return {
    crm: {
      dashboard: vi.fn().mockResolvedValue(dashboard), pipeline: vi.fn().mockResolvedValue(stages),
      contacts: { list: listContacts, get: vi.fn().mockResolvedValue(details),
        ensure: vi.fn(), update: vi.fn(), setStage: vi.fn().mockResolvedValue(details), setLifecycle: vi.fn() },
      notes: { list: vi.fn().mockResolvedValue([]), add: vi.fn(), delete: vi.fn() },
      tasks: { list: vi.fn().mockResolvedValue([]), save: vi.fn(), delete: vi.fn() },
      catalog: { list: vi.fn().mockResolvedValue([]), save: vi.fn(), delete: vi.fn() },
      orders: { list: vi.fn().mockResolvedValue([]), get: vi.fn(), save: vi.fn(), delete: vi.fn() },
      activity: vi.fn().mockResolvedValue([])
    },
    contacts: { get: vi.fn().mockResolvedValue({ chatId: contact.chatId, kind: 'direct', title: contact.name,
      savedName: undefined, whatsappName: contact.whatsappName, phoneNumber: contact.phoneNumber,
      pinned: false, archived: false }), save: vi.fn() },
    session: { getState: vi.fn().mockResolvedValue({ phase: 'connected', accountState: 'linked' }) }
  }
}

beforeEach(() => {
  useUiStore.setState({ destination: 'crm', selectedCrmContactId: undefined, selectedChatId: undefined, notices: [] })
  Object.defineProperty(window, 'warish', { configurable: true, value: mockApi() })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'warish')
})

describe('CrmShell', () => {
  it('shows a compact operational overview and opens the lead record from the list', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><CrmShell /></QueryClientProvider>)

    expect(await screen.findByText('New enquiries')).toBeInTheDocument()
    expect(screen.getByText('Revenue this month')).toBeInTheDocument()
    expect(screen.getByText('Latest contacts')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Leads/ }))
    expect(await screen.findByRole('columnheader', { name: 'Contact' })).toBeInTheDocument()
    fireEvent.click(screen.getByText('Priya Enquiry'))
    await waitFor(() => expect(useUiStore.getState().selectedCrmContactId).toBe('crm-1'))
    const contactPanel = await screen.findByRole('complementary', { name: 'CRM contact record' })
    expect(Array.from(contactPanel.querySelectorAll('.crm-contact-tabs button')).map((button) => button.textContent)).toEqual([
      'orders', 'overview', 'notes', 'tasks', 'activity'
    ])
    expect(within(contactPanel).getByRole('button', { name: 'orders' })).toHaveClass('active')
    expect(await within(contactPanel).findByRole('button', { name: 'New order' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save contact' })).toBeInTheDocument()
    expect(screen.getAllByText('+919876543210').length).toBeGreaterThan(0)
  })

  it('shows converted contacts in terminal lead-stage filters without changing All leads', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><CrmShell /></QueryClientProvider>)
    fireEvent.click(await screen.findByRole('button', { name: /^Leads/ }))

    const listContacts = vi.mocked(window.warish.crm.contacts.list)
    await waitFor(() => expect(listContacts).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: 'lead', stageId: undefined })))

    fireEvent.click(await screen.findByRole('button', { name: 'Won' }))
    expect(await screen.findByText('Won Customer')).toBeInTheDocument()
    expect(listContacts).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: 'active', stageId: 'stage-won' }))

    fireEvent.click(screen.getByRole('button', { name: 'Lost' }))
    expect(await screen.findByText('Lost Customer')).toBeInTheDocument()
    expect(listContacts).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: 'active', stageId: 'stage-lost' }))

    fireEvent.click(screen.getByRole('button', { name: 'All leads' }))
    expect(await screen.findByText('Priya Enquiry')).toBeInTheDocument()
    expect(listContacts).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: 'lead', stageId: undefined }))
  })

  it('disables contact-dependent actions and explains the empty CRM state', async () => {
    vi.mocked(window.warish.crm.contacts.list).mockResolvedValue([])
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><CrmShell /></QueryClientProvider>)

    const navigation = screen.getByRole('navigation', { name: 'CRM sections' })
    fireEvent.click(within(navigation).getByRole('button', { name: 'Tasks' }))
    const newTask = await screen.findByRole('button', { name: 'New task' })
    await waitFor(() => expect(newTask).toBeDisabled())
    expect(newTask).toHaveAttribute('title', 'Save a WhatsApp contact before creating a task')
    expect(await screen.findByText('No contacts to follow up with')).toBeInTheDocument()
    expect(screen.getByText('Save a WhatsApp contact before creating a task.')).toBeInTheDocument()
  })

  it('flags an order payment that exceeds the calculated total', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><CrmShell /></QueryClientProvider>)

    const navigation = screen.getByRole('navigation', { name: 'CRM sections' })
    fireEvent.click(within(navigation).getByRole('button', { name: 'Orders' }))
    const newOrder = await screen.findByRole('button', { name: 'New order' })
    await waitFor(() => expect(newOrder).toBeEnabled())
    fireEvent.click(newOrder)
    const dialog = await screen.findByRole('dialog', { name: 'New order' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Item name' }), { target: { value: 'Consultation' } })
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Rate' }), { target: { value: '100' } })
    const payment = within(dialog).getByRole('spinbutton', { name: 'Payment received' })
    expect(payment).toHaveAttribute('max', '100')
    fireEvent.change(payment, { target: { value: '101' } })
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Payment cannot exceed the order total.')
    expect(within(dialog).getByRole('button', { name: 'Save order' })).toBeDisabled()
  })
})
