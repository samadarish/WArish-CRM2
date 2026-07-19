import { memo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive, ArchiveRestore, BellOff, BellRing, BriefcaseBusiness, ContactRound, Info, LoaderCircle, MessageCircle, Network, Pin, PinOff,
  Radio, UserRound, UsersRound, X
} from 'lucide-react'
import type { ChatSummary, ContactDetails } from '../../../shared/contracts'
import { MotionPresence } from '../motion'
import { useUiStore } from '../store'
import { Avatar } from './Avatar'
import { CrmContactPanel } from './CrmShell'
import { WhatsAppContactDialog } from './WhatsAppContactDialog'

export const ContactDrawer = memo(function ContactDrawer({ chat, onClose, onArchived, onJumpToMessage, persistent = false, overlayOpen = false }: {
  chat: ChatSummary
  onClose(): void
  onArchived(): void
  onJumpToMessage?(messageId: string): void
  persistent?: boolean
  overlayOpen?: boolean
}): React.JSX.Element {
  const [contactSaveOpen, setContactSaveOpen] = useState(false)
  const pushNotice = useUiStore((state) => state.pushNotice)
  const queryClient = useQueryClient()
  const detailsQuery = useQuery({
    queryKey: ['contact', chat.id],
    queryFn: () => window.warish.contacts.get(chat.id),
    initialData: toInitialDetails(chat)
  })
  const details = detailsQuery.data
  const crmQuery = useQuery({ queryKey: ['crm', 'contact', 'chat', chat.id],
    queryFn: () => window.warish.crm.contacts.get({ chatId: chat.id }), enabled: details.kind === 'direct', retry: false })
  const stagesQuery = useQuery({ queryKey: ['crm', 'pipeline'], queryFn: () => window.warish.crm.pipeline(),
    enabled: details.kind === 'direct' })
  const sessionQuery = useQuery({ queryKey: ['session'], queryFn: () => window.warish.session.getState(), staleTime: 30_000 })
  const ensureCrm = useMutation({ mutationFn: () => window.warish.crm.contacts.ensure(chat.id), onSuccess: (contact) => {
    queryClient.setQueryData(['crm', 'contact', contact.id], contact)
    queryClient.setQueryData(['crm', 'contact', 'chat', chat.id], contact)
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['crm', 'contacts'] }),
      queryClient.invalidateQueries({ queryKey: ['crm', 'dashboard'] })
    ])
  }, onError: (error) => pushNotice(error instanceof Error ? error.message : 'Could not add this contact to CRM') })
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
  const conversationOverview = <ConversationOverview details={details} muted={muted} pending={action.isPending}
    onUpdate={(patch) => action.mutate(patch)} />
  const persistentClasses = `${persistent ? 'persistent-contact-panel' : ''} ${overlayOpen ? 'details-overlay-open' : ''}`

  if (details.kind === 'direct' && crmQuery.data) return <CrmContactPanel contactId={crmQuery.data.id}
    stages={stagesQuery.data ?? []} onClose={onClose} inConversation overviewPrefix={conversationOverview}
    onJumpToMessage={onJumpToMessage} persistent={persistent} overlayOpen={overlayOpen} />

  if (details.kind === 'direct' && crmQuery.isFetching && !crmQuery.isError) return <aside className={`crm-contact-panel in-conversation ${persistentClasses}`}
    aria-label="CRM contact record"><header><div><span>Customer details</span><strong>{details.title}</strong></div>
      <button className="icon-button contact-panel-close" aria-label="Close customer details" onClick={onClose}><X /></button></header>
    <div className="crm-state"><LoaderCircle className="spin" /><span>Loading customer details…</span></div></aside>

  if (details.kind === 'direct') return <><aside className={`crm-contact-panel in-conversation crm-untracked-contact ${persistentClasses}`} aria-label="CRM contact record">
    <header><div><span>WhatsApp contact</span><strong>Customer workspace</strong></div><button className="icon-button contact-panel-close" aria-label="Close customer details" onClick={onClose}><X /></button></header>
    <div className="crm-contact-hero"><Avatar title={details.title} src={details.avatarUrl} large /><div className="crm-contact-copy"><h2>{details.title}</h2>
      {details.whatsappName && details.whatsappName !== details.title && <span className="whatsapp-profile-pill">{details.whatsappName}</span>}
      {details.phoneNumber && <p>{details.phoneNumber}</p>}</div></div>
    <div className="crm-contact-actions"><button onClick={onClose}><MessageCircle />Message</button>
      <button disabled={ensureCrm.isPending} onClick={() => ensureCrm.mutate()}><BriefcaseBusiness />Track</button>
      <button disabled><Archive />Order</button><button disabled={sessionQuery.data?.phase !== 'connected'}
        title={sessionQuery.data?.phase === 'connected' ? undefined : 'Connect WhatsApp to save this contact'}
        onClick={() => setContactSaveOpen(true)}><ContactRound />{details.savedName ? 'Edit contact' : 'Save contact'}</button></div>
    <nav className="crm-contact-tabs"><button className="active">Overview</button><button disabled>Notes</button><button disabled>Tasks</button><button disabled>Orders</button><button disabled>Activity</button></nav>
    <div className="crm-contact-body"><div className="crm-profile-section">{conversationOverview}<section className="crm-start-tracking"><BriefcaseBusiness />
      <strong>Not tracked in CRM</strong><button className="primary-button" disabled={ensureCrm.isPending} onClick={() => ensureCrm.mutate()}>
        {ensureCrm.isPending ? <LoaderCircle className="spin" /> : <BriefcaseBusiness />}Add to CRM</button></section></div></div>
  </aside><MotionPresence show={contactSaveOpen}>{contactSaveOpen && <WhatsAppContactDialog chatId={chat.id}
    initialName={details.savedName ?? details.whatsappName ?? details.title} phoneNumber={details.phoneNumber}
    saved={Boolean(details.savedName)} onClose={() => setContactSaveOpen(false)} />}</MotionPresence></>

  return <aside className="contact-drawer" aria-label="Conversation details">
    <header><strong>Conversation info</strong><button className="icon-button" aria-label="Close conversation info" onClick={onClose}><X /></button></header>
    {detailsQuery.isFetching && !details ? <div className="loading-row"><LoaderCircle className="spin" />Loading details…</div> : <>
      <div className="contact-profile"><Avatar title={details.title} src={details.avatarUrl} large /><h2>{details.title}</h2></div>
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
})

function ConversationOverview({ details, muted, pending, onUpdate }: {
  details: ContactDetails
  muted: boolean
  pending: boolean
  onUpdate(patch: Partial<Pick<ChatSummary, 'archived' | 'pinned' | 'mutedUntil'>>): void
}): React.JSX.Element {
  return <section className="conversation-overview"><header><strong>WhatsApp conversation</strong></header><div className="contact-actions">
    <button disabled={pending} onClick={() => onUpdate({ pinned: !details.pinned })}>{details.pinned ? <PinOff /> : <Pin />}<span>{details.pinned ? 'Unpin' : 'Pin'}</span></button>
    <button disabled={pending} onClick={() => onUpdate({ mutedUntil: muted ? 0 : Number.MAX_SAFE_INTEGER })}>{muted ? <BellRing /> : <BellOff />}<span>{muted ? 'Unmute' : 'Mute'}</span></button>
    <button disabled={pending} onClick={() => onUpdate({ archived: !details.archived })}>{details.archived ? <ArchiveRestore /> : <Archive />}<span>{details.archived ? 'Restore' : 'Archive'}</span></button>
  </div></section>
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
