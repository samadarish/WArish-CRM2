import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive, ArchiveRestore, BellOff, BellRing, Info, LoaderCircle, MessageCircle, Network, Pin, PinOff,
  Radio, UserRound, UsersRound, X
} from 'lucide-react'
import type { ChatSummary, ContactDetails } from '../../../shared/contracts'
import { useUiStore } from '../store'
import { Avatar } from './Avatar'

export function ContactDrawer({ chat, onClose, onArchived }: {
  chat: ChatSummary
  onClose(): void
  onArchived(): void
}): React.JSX.Element {
  const pushNotice = useUiStore((state) => state.pushNotice)
  const queryClient = useQueryClient()
  const detailsQuery = useQuery({
    queryKey: ['contact', chat.id],
    queryFn: () => window.warish.contacts.get(chat.id),
    initialData: toInitialDetails(chat)
  })
  const details = detailsQuery.data
  const action = useMutation({
    mutationFn: (patch: Partial<Pick<ChatSummary, 'archived' | 'pinned' | 'mutedUntil'>>) =>
      window.warish.chats.update(chat.id, patch),
    onSuccess: async (_result, patch) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['chat', chat.id] }),
        queryClient.invalidateQueries({ queryKey: ['contact', chat.id] }),
        queryClient.invalidateQueries({ queryKey: ['chats'] }),
        queryClient.invalidateQueries({ queryKey: ['communities'] })
      ])
      if (patch.archived !== undefined) onArchived()
    },
    onError: (error) => pushNotice(error instanceof Error ? error.message : 'Could not update this conversation')
  })
  const muted = Boolean(details.mutedUntil && details.mutedUntil > Date.now())

  return <aside className="contact-drawer" aria-label="Conversation details">
    <header><strong>Conversation info</strong><button className="icon-button" aria-label="Close conversation info" onClick={onClose}><X /></button></header>
    {detailsQuery.isFetching && !details ? <div className="loading-row"><LoaderCircle className="spin" />Loading details…</div> : <>
      <div className="contact-profile"><Avatar title={details.title} src={details.avatarUrl} large /><h2>{details.title}</h2>
        {details.kind === 'direct' && !details.savedName && !details.whatsappName && <span>Identity details are not shared by WhatsApp.</span>}
      </div>
      <div className="contact-actions">
        <button disabled={action.isPending} onClick={() => action.mutate({ pinned: !details.pinned })}>{details.pinned ? <PinOff /> : <Pin />}<span>{details.pinned ? 'Unpin' : 'Pin'}</span></button>
        <button disabled={action.isPending} onClick={() => action.mutate({ mutedUntil: muted ? 0 : Number.MAX_SAFE_INTEGER })}>{muted ? <BellRing /> : <BellOff />}<span>{muted ? 'Unmute' : 'Mute'}</span></button>
        <button disabled={action.isPending} onClick={() => action.mutate({ archived: !details.archived })}>{details.archived ? <ArchiveRestore /> : <Archive />}<span>{details.archived ? 'Restore' : 'Archive'}</span></button>
      </div>
      <section className="contact-detail-list">
        <Detail icon={<KindIcon kind={details.kind} />} label="Conversation type" value={kindLabel(details)} />
        {details.savedName && <Detail icon={<UserRound />} label="Saved contact name" value={details.savedName} />}
        {details.whatsappName && <Detail icon={<MessageCircle />} label="WhatsApp profile name" value={details.whatsappName} />}
        {details.phoneNumber && <Detail icon={<Info />} label="Phone number" value={details.phoneNumber} />}
        {details.communityId && <Detail icon={<Network />} label="Community" value="Part of a WhatsApp community" />}
        {details.description && <Detail icon={<Info />} label="Description" value={details.description} />}
      </section>
    </>}
  </aside>
}

function Detail({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }): React.JSX.Element {
  return <div className="contact-detail"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>
}

function KindIcon({ kind }: { kind: ContactDetails['kind'] }): React.JSX.Element {
  if (kind === 'channel') return <Radio />
  if (kind === 'community') return <Network />
  if (kind === 'group') return <UsersRound />
  return <UserRound />
}

function kindLabel(details: ContactDetails): string {
  if (details.kind === 'channel') return 'Channel · read only'
  if (details.kind === 'community') return 'Community'
  if (details.communityId) return details.kind === 'group' ? 'Community group' : 'Community conversation'
  if (details.kind === 'group') return 'Group'
  if (details.kind === 'direct') return 'Direct chat'
  return 'WhatsApp conversation'
}

function toInitialDetails(chat: ChatSummary): ContactDetails {
  return { chatId: chat.id, kind: chat.kind, title: chat.title, savedName: chat.savedName,
    whatsappName: chat.whatsappName, phoneNumber: chat.phoneNumber, avatarUrl: chat.avatarUrl,
    communityId: chat.communityId, description: chat.description, pinned: chat.pinned,
    archived: chat.archived, mutedUntil: chat.mutedUntil }
}
