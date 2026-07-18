import type { ChatCategory, ChatSummary } from '../../shared/contracts'

export type WorkspaceDestination = ChatCategory | 'archived'

export const WORKSPACE_DESTINATIONS: readonly WorkspaceDestination[] = [
  'direct', 'group', 'community', 'channel', 'all', 'archived'
]

export function destinationForChat(chat: ChatSummary): WorkspaceDestination {
  if (chat.archived) return 'archived'
  if (chat.kind === 'community' || chat.communityId) return 'community'
  if (chat.kind === 'direct' || chat.kind === 'group' || chat.kind === 'channel') return chat.kind
  return 'all'
}
