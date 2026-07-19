import { create } from 'zustand'
import type { WorkspaceDestination } from './workspace-navigation'
export type { WorkspaceDestination } from './workspace-navigation'

interface UiState {
  selectedChatId?: string
  selectedCrmContactId?: string
  destination: WorkspaceDestination
  settingsOpen: boolean
  notices: Array<{ id: number; message: string; tone: 'error' | 'info' }>
  selectChat(chatId?: string): void
  navigate(destination: WorkspaceDestination): void
  openChat(chatId: string, destination: WorkspaceDestination): void
  openCrmContact(contactId?: string): void
  setSettingsOpen(open: boolean): void
  pushNotice(message: string, tone?: 'error' | 'info'): void
  dismissNotice(id: number): void
}

let nextNoticeId = 1

export const useUiStore = create<UiState>((set) => ({
  destination: 'direct',
  settingsOpen: false,
  notices: [],
  selectChat: (selectedChatId) => set({ selectedChatId }),
  navigate: (destination) => set({ destination, selectedChatId: undefined }),
  openChat: (selectedChatId, destination) => set({ selectedChatId, destination }),
  openCrmContact: (selectedCrmContactId) => set({ selectedCrmContactId, selectedChatId: undefined, destination: 'crm' }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  pushNotice: (message, tone = 'error') => set((state) => ({
    notices: [...state.notices.slice(-2), { id: nextNoticeId++, message, tone }]
  })),
  dismissNotice: (id) => set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) }))
}))
