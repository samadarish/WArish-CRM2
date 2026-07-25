import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive, BriefcaseBusiness, Inbox, Network, PanelLeftClose, PanelLeftOpen, Radio, Settings, UserRound, UsersRound
} from 'lucide-react'
import type { AppSettings } from '../../../shared/contracts'
import { useUiStore, type WorkspaceDestination } from '../store'
import { WORKSPACE_DESTINATIONS } from '../workspace-navigation'
import { BrandMark } from './BrandMark'

export type SidebarDestination = WorkspaceDestination

export function NavigationRail({ current, onNavigate }: {
  current: SidebarDestination
  onNavigate(destination: SidebarDestination): void
}): React.JSX.Element {
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen)
  const pushNotice = useUiStore((state) => state.pushNotice)
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: () => window.warish.settings.get() })
  const narrow = useMediaQuery('(max-width: 1120px)')
  const mode = settingsQuery.data?.navigationMode ?? 'auto'
  const expanded = mode === 'expanded' || (mode === 'auto' && !narrow)
  const update = useMutation({
    mutationFn: (navigationMode: AppSettings['navigationMode']) => window.warish.settings.update({ navigationMode }),
    onSuccess: (settings) => queryClient.setQueryData(['settings'], settings),
    onError: (error) => pushNotice(error instanceof Error ? error.message : 'Could not resize navigation')
  })
  const toggle = (): void => update.mutate(expanded ? 'collapsed' : 'expanded')

  return <nav className={`nav-rail ${expanded ? 'expanded' : 'collapsed'}`} aria-label="Primary navigation">
    <div className="nav-brand"><BrandMark variant="compact" size="small" /><strong>WArish</strong></div>
    {WORKSPACE_DESTINATIONS.map((destination) => <RailButton key={destination} destination={destination} current={current}
      label={destinationLabel(destination)} onClick={onNavigate}>{destinationIcon(destination)}</RailButton>)}
    <div className="nav-spacer" />
    <button className="nav-button" title={expanded ? 'Collapse navigation' : 'Expand navigation'}
      aria-label={expanded ? 'Collapse navigation' : 'Expand navigation'} disabled={update.isPending} onClick={toggle}>
      {expanded ? <PanelLeftClose /> : <PanelLeftOpen />}<span>{expanded ? 'Collapse' : 'Expand'}</span>
    </button>
    <button className="nav-button" title="Settings" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
      <Settings /><span>Settings</span>
    </button>
  </nav>
}

function destinationLabel(destination: SidebarDestination): string {
  const labels: Record<SidebarDestination, string> = {
    direct: 'Chats', crm: 'CRM', group: 'Groups', community: 'Communities', channel: 'Channels', all: 'All conversations', archived: 'Archived'
  }
  return labels[destination]
}

function destinationIcon(destination: SidebarDestination): React.ReactNode {
  if (destination === 'direct') return <UserRound />
  if (destination === 'crm') return <BriefcaseBusiness />
  if (destination === 'group') return <UsersRound />
  if (destination === 'community') return <Network />
  if (destination === 'channel') return <Radio />
  if (destination === 'archived') return <Archive />
  return <Inbox />
}

function RailButton({ destination, current, label, onClick, children }: {
  destination: SidebarDestination
  current: SidebarDestination
  label: string
  onClick(destination: SidebarDestination): void
  children: React.ReactNode
}): React.JSX.Element {
  const active = destination === current
  return <button className={`nav-button ${active ? 'active' : ''}`} title={label} aria-label={label}
    aria-current={active ? 'page' : undefined} onClick={() => onClick(destination)}>{children}<span>{label}</span></button>
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const update = (): void => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}
