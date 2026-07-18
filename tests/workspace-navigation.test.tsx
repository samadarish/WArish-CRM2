import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatSummary, SessionState } from '../src/shared/contracts'
import { resolveSessionSurface } from '../src/renderer/src/session-surface'
import { useUiStore } from '../src/renderer/src/store'
import { destinationForChat, WORKSPACE_DESTINATIONS } from '../src/renderer/src/workspace-navigation'

function chat(patch: Partial<ChatSummary> = {}): ChatSummary {
  return { id: 'chat-1', title: 'Example', kind: 'direct', unreadCount: 0, archived: false, pinned: false, ...patch }
}

function session(patch: Partial<SessionState> = {}): SessionState {
  return { phase: 'starting', accountState: 'linked', ...patch }
}

beforeEach(() => useUiStore.setState({ destination: 'direct', selectedChatId: undefined }))

describe('workspace navigation', () => {
  it('keeps Chats first and All conversations below Channels', () => {
    expect(WORKSPACE_DESTINATIONS).toEqual(['direct', 'group', 'community', 'channel', 'all', 'archived'])
    expect(useUiStore.getState().destination).toBe('direct')
  })

  it('clears a stale conversation when the user changes destinations', () => {
    useUiStore.getState().openChat('direct-1', 'direct')
    useUiStore.getState().navigate('group')
    expect(useUiStore.getState()).toMatchObject({ destination: 'group', selectedChatId: undefined })
  })

  it('routes external chats to the matching sidebar context', () => {
    expect(destinationForChat(chat())).toBe('direct')
    expect(destinationForChat(chat({ kind: 'group' }))).toBe('group')
    expect(destinationForChat(chat({ kind: 'group', communityId: 'community-1' }))).toBe('community')
    expect(destinationForChat(chat({ kind: 'channel' }))).toBe('channel')
    expect(destinationForChat(chat({ archived: true }))).toBe('archived')
  })
})

describe('session surface routing', () => {
  it('uses onboarding only for accounts that have never been linked', () => {
    expect(resolveSessionSurface(session({ phase: 'unlinked', accountState: 'never-linked' }))).toBe('onboarding')
    expect(resolveSessionSurface(session({ phase: 'pairing', accountState: 'never-linked' }))).toBe('onboarding')
  })

  it.each(['starting', 'connecting', 'offline', 'error', 'connected'] as const)('keeps a linked account in the workspace during %s', (phase) => {
    expect(resolveSessionSurface(session({ phase, accountState: 'linked' }))).toBe('workspace')
  })

  it('keeps local history visible when relinking is required', () => {
    expect(resolveSessionSurface(session({ phase: 'logged-out', accountState: 'relink-required' }))).toBe('workspace')
  })
})
