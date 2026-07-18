import type { SessionState } from '../../shared/contracts'

export type SessionSurface = 'onboarding' | 'workspace'

export function resolveSessionSurface(session: SessionState): SessionSurface {
  return session.accountState === 'never-linked' ? 'onboarding' : 'workspace'
}
