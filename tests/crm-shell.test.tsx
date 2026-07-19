// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrmContactDetailsDto, CrmContactSummaryDto, CrmDashboardDto, CrmStageDto } from '../src/shared/contracts'
import { CrmShell } from '../src/renderer/src/components/CrmShell'
import { useUiStore } from '../src/renderer/src/store'

const stages: CrmStageDto[] = [
  { id: 'stage-new', key: 'new', name: 'New enquiry', color: '#0ea5a4', position: 0, outcome: 'open' },
  { id: 'stage-won', key: 'won', name: 'Won', color: '#16a34a', position: 1, outcome: 'won' }
]
const contact: CrmContactSummaryDto = {
  id: 'crm-1', identityId: 'identity-1', chatId: 'chat-1', lifecycle: 'lead', stageId: 'stage-new', stageKey: 'new',
  stageName: 'New enquiry', stageColor: '#0ea5a4', name: 'Priya Enquiry', whatsappName: 'Priya WA',
  phoneNumber: '+919876543210', company: 'Priya Studio', source: 'whatsapp', tags: [], createdAt: Date.now() - 60_000,
  lastActivityAt: Date.now(), orderCount: 0, lifetimeValue: 0, openTaskCount: 1
}
const details: CrmContactDetailsDto = { ...contact, consentStatus: 'unknown', doNotContact: false, customFields: {} }
const dashboard: CrmDashboardDto = { newLeads: 1, openLeads: 1, customers: 0, overdueTasks: 1, ordersThisMonth: 0,
  revenueThisMonth: 0, lifetimeRevenue: 0, recentContacts: [contact], pipeline: stages.map((stage) => ({ ...stage,
    count: stage.key === 'new' ? 1 : 0, value: 0 })) }

function mockApi(): Record<string, unknown> {
  return {
    crm: {
      dashboard: vi.fn().mockResolvedValue(dashboard), pipeline: vi.fn().mockResolvedValue(stages),
      contacts: { list: vi.fn().mockResolvedValue([contact]), get: vi.fn().mockResolvedValue(details),
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
    expect(await screen.findByRole('complementary', { name: 'CRM contact record' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save contact' })).toBeInTheDocument()
    expect(screen.getAllByText('+919876543210').length).toBeGreaterThan(0)
  })
})
