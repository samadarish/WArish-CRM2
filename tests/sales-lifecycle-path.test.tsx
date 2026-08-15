// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatSummary, CrmContactDetailsDto, CrmStageDto } from '../src/shared/contracts'
import { SalesLifecyclePath } from '../src/renderer/src/components/SalesLifecyclePath'
import { useUiStore } from '../src/renderer/src/store'

const stages: CrmStageDto[] = [
  { id: 'stage-quoted', key: 'quoted', name: 'Quoted', color: '#8B5CF6', position: 2, outcome: 'open' },
  { id: 'stage-new', key: 'new', name: 'New enquiry', color: '#F59E0B', position: 0, outcome: 'open' },
  { id: 'stage-lost', key: 'lost', name: 'Lost', color: '#EF4444', position: 4, outcome: 'lost' },
  { id: 'stage-qualified', key: 'qualified', name: 'Qualified', color: '#EAB308', position: 1, outcome: 'open' },
  { id: 'stage-won', key: 'won', name: 'Won', color: '#84CC16', position: 3, outcome: 'won' }
]

const baseChat: ChatSummary = {
  id: '15550001111@s.whatsapp.net', title: 'Priya', kind: 'direct', unreadCount: 0, archived: false, pinned: false
}

function contact(stageId = 'stage-new'): CrmContactDetailsDto {
  const stage = stages.find((candidate) => candidate.id === stageId) ?? stages[1]!
  return {
    id: 'crm-1', identityId: 'identity-1', chatId: baseChat.id, lifecycle: stage.key === 'won' ? 'customer' : 'lead',
    stageId: stage.id, stageKey: stage.key, stageName: stage.name, stageColor: stage.color, name: 'Priya', source: 'manual',
    tags: [], createdAt: 1, lastActivityAt: 1, orderCount: 0, lifetimeValue: 0, openTaskCount: 0,
    consentStatus: 'unknown', doNotContact: false, customFields: {}
  }
}

function trackedChat(stageId = 'stage-quoted'): ChatSummary {
  const details = contact(stageId)
  return { ...baseChat, crm: { contactId: details.id, lifecycle: details.lifecycle, stageId: details.stageId,
    stageKey: details.stageKey, stageName: details.stageName, stageColor: details.stageColor, openTaskCount: 0, restricted: false } }
}

function renderPath(chat: ChatSummary, overrides: { ensure?: ReturnType<typeof vi.fn>; setStage?: ReturnType<typeof vi.fn> } = {}) {
  const ensure = overrides.ensure ?? vi.fn().mockResolvedValue(contact())
  const setStage = overrides.setStage ?? vi.fn().mockImplementation((_contactId: string, stageId: string) => Promise.resolve(contact(stageId)))
  Object.defineProperty(window, 'warish', { configurable: true, value: {
    crm: { pipeline: vi.fn().mockResolvedValue(stages), contacts: { ensure, setStage } }
  } })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><SalesLifecyclePath chat={chat} /></QueryClientProvider>)
  return { ensure, setStage }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'warish')
  useUiStore.setState({ notices: [] })
})

describe('SalesLifecyclePath', () => {
  it('orders stages by pipeline position and marks completed and current stages', async () => {
    renderPath(trackedChat())
    const group = await screen.findByRole('group', { name: 'Pipeline stages' })
    expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'New enquiry', 'Qualified', 'Quoted', 'Won', 'Lost'
    ])
    expect(screen.getByRole('button', { name: 'Set sales stage to New enquiry' })).toHaveClass('completed')
    expect(screen.getByRole('button', { name: 'Set sales stage to Qualified' })).toHaveClass('completed')
    expect(screen.getByRole('button', { name: 'Set sales stage to Quoted' })).toHaveAttribute('aria-current', 'step')
  })

  it('does not present the mutually exclusive won outcome as completed for a lost lead', async () => {
    renderPath(trackedChat('stage-lost'))
    await screen.findByRole('group', { name: 'Pipeline stages' })
    expect(screen.getByRole('button', { name: 'Set sales stage to Quoted' })).toHaveClass('completed')
    expect(screen.getByRole('button', { name: 'Set sales stage to Won' })).not.toHaveClass('completed')
    expect(screen.getByRole('button', { name: 'Set sales stage to Lost' })).toHaveAttribute('aria-current', 'step')
  })

  it('updates a tracked contact immediately without ensuring another CRM record', async () => {
    const { ensure, setStage } = renderPath(trackedChat())
    fireEvent.click(await screen.findByRole('button', { name: 'Set sales stage to Won' }))
    await waitFor(() => expect(setStage).toHaveBeenCalledWith('crm-1', 'stage-won'))
    expect(ensure).not.toHaveBeenCalled()
  })

  it('creates an untracked contact lazily and avoids a redundant default-stage update', async () => {
    const { ensure, setStage } = renderPath(baseChat)
    expect(await screen.findByText('Not tracked')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Set sales stage to New enquiry' }))
    await waitFor(() => expect(ensure).toHaveBeenCalledWith(baseChat.id))
    expect(setStage).not.toHaveBeenCalled()
  })

  it('creates an untracked contact before applying a later stage and rolls back failed changes', async () => {
    const ensure = vi.fn().mockResolvedValue(contact())
    const setStage = vi.fn().mockRejectedValue(new Error('Stage update failed'))
    renderPath(baseChat, { ensure, setStage })
    const qualified = await screen.findByRole('button', { name: 'Set sales stage to Qualified' })
    fireEvent.click(qualified)
    await waitFor(() => expect(setStage).toHaveBeenCalledWith('crm-1', 'stage-qualified'))
    await waitFor(() => expect(qualified).not.toHaveAttribute('aria-current'))
    expect(useUiStore.getState().notices.at(-1)?.message).toBe('Stage update failed')
  })
})
