import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import {
  BadgeIndianRupee, BriefcaseBusiness, CalendarClock, Check, ChevronRight, CircleDollarSign, ContactRound,
  ExternalLink, FileText, LayoutDashboard, ListTodo, LoaderCircle, MessageCircle, NotebookPen,
  Package, Pencil, Plus, RefreshCw, Search, ShoppingBag, Trash2, UserRound, UsersRound, X
} from 'lucide-react'
import type {
  CrmCatalogItemDto, CrmContactDetailsDto, CrmContactSummaryDto, CrmDashboardDto,
  CrmMessageReferenceDto, CrmNoteDto, CrmOrderDto, CrmOrderInput, CrmStageDto, CrmTaskDto
} from '../../../shared/contracts'
import { useUiStore } from '../store'
import { Avatar } from './Avatar'
import { WhatsAppContactDialog } from './WhatsAppContactDialog'

type CrmView = 'overview' | 'leads' | 'customers' | 'orders' | 'tasks' | 'catalog'
type ContactTab = 'overview' | 'notes' | 'tasks' | 'orders' | 'activity'

const CRM_VIEWS: Array<{ id: CrmView; label: string; icon: ReactNode }> = [
  { id: 'overview', label: 'Overview', icon: <LayoutDashboard /> },
  { id: 'leads', label: 'Leads', icon: <BriefcaseBusiness /> },
  { id: 'customers', label: 'Customers', icon: <UsersRound /> },
  { id: 'orders', label: 'Orders', icon: <ShoppingBag /> },
  { id: 'tasks', label: 'Tasks', icon: <ListTodo /> },
  { id: 'catalog', label: 'Catalog', icon: <Package /> }
]

export function CrmShell(): React.JSX.Element {
  const [view, setView] = useState<CrmView>('overview')
  const [query, setQuery] = useState('')
  const [stageId, setStageId] = useState('')
  const [taskDialogContactId, setTaskDialogContactId] = useState<string>()
  const [orderDialogContactId, setOrderDialogContactId] = useState<string>()
  const [editingOrder, setEditingOrder] = useState<CrmOrderDto>()
  const [catalogDialogItem, setCatalogDialogItem] = useState<CrmCatalogItemDto | null>()
  const selectedContactId = useUiStore((state) => state.selectedCrmContactId)
  const openCrmContact = useUiStore((state) => state.openCrmContact)
  const pushNotice = useUiStore((state) => state.pushNotice)
  const queryClient = useQueryClient()
  const dashboardQuery = useQuery({ queryKey: ['crm', 'dashboard'], queryFn: () => window.warish.crm.dashboard() })
  const stagesQuery = useQuery({ queryKey: ['crm', 'pipeline'], queryFn: () => window.warish.crm.pipeline() })
  const contactsQuery = useQuery({
    queryKey: ['crm', 'contacts', view, stageId, query],
    queryFn: () => window.warish.crm.contacts.list({ lifecycle: view === 'customers' ? 'customer' : 'lead',
      stageId: stageId || undefined, query: query || undefined, limit: 500 }),
    enabled: view === 'leads' || view === 'customers'
  })
  const allContactsQuery = useQuery({ queryKey: ['crm', 'contacts', 'active'],
    queryFn: () => window.warish.crm.contacts.list({ lifecycle: 'active', limit: 500 }),
    enabled: view === 'orders' || view === 'tasks' || Boolean(taskDialogContactId) || Boolean(orderDialogContactId) })
  const ordersQuery = useQuery({ queryKey: ['crm', 'orders'], queryFn: () => window.warish.crm.orders.list(), enabled: view === 'orders' })
  const tasksQuery = useQuery({ queryKey: ['crm', 'tasks'], queryFn: () => window.warish.crm.tasks.list(), enabled: view === 'tasks' })
  const catalogQuery = useQuery({ queryKey: ['crm', 'catalog'], queryFn: () => window.warish.crm.catalog.list(undefined, true),
    enabled: view === 'catalog' || Boolean(orderDialogContactId) })

  const prefetchView = useCallback((next: CrmView): void => {
    if (next === 'overview') {
      void queryClient.prefetchQuery({ queryKey: ['crm', 'dashboard'], queryFn: () => window.warish.crm.dashboard(), staleTime: 15_000 })
      return
    }
    if (next === 'leads' || next === 'customers') {
      void queryClient.prefetchQuery({
        queryKey: ['crm', 'contacts', next, '', ''],
        queryFn: () => window.warish.crm.contacts.list({ lifecycle: next === 'customers' ? 'customer' : 'lead', limit: 500 }),
        staleTime: 15_000
      })
      return
    }
    void queryClient.prefetchQuery({
      queryKey: ['crm', 'contacts', 'active'],
      queryFn: () => window.warish.crm.contacts.list({ lifecycle: 'active', limit: 500 }),
      staleTime: 15_000
    })
    if (next === 'orders') void queryClient.prefetchQuery({ queryKey: ['crm', 'orders'], queryFn: () => window.warish.crm.orders.list(), staleTime: 15_000 })
    if (next === 'tasks') void queryClient.prefetchQuery({ queryKey: ['crm', 'tasks'], queryFn: () => window.warish.crm.tasks.list(), staleTime: 15_000 })
    if (next === 'catalog') void queryClient.prefetchQuery({ queryKey: ['crm', 'catalog'], queryFn: () => window.warish.crm.catalog.list(undefined, true), staleTime: 15_000 })
  }, [queryClient])
  const changeView = useCallback((next: CrmView): void => {
    setView(next); setQuery(''); setStageId('')
  }, [])

  return <main className="crm-workspace">
    <header className="crm-topbar"><div><span>Customer workspace</span><h1>{CRM_VIEWS.find((item) => item.id === view)?.label}</h1></div>
      <div className="crm-topbar-actions">
        {(view === 'leads' || view === 'customers') && <label className="crm-search"><Search /><input value={query}
          placeholder={`Search ${view}`} onChange={(event) => setQuery(event.target.value)} />{query && <button aria-label="Clear search" onClick={() => setQuery('')}><X /></button>}</label>}
        {view === 'tasks' && <button className="primary-button" onClick={() => setTaskDialogContactId(allContactsQuery.data?.[0]?.id)}><Plus />New task</button>}
        {view === 'orders' && <button className="primary-button" onClick={() => setOrderDialogContactId(allContactsQuery.data?.[0]?.id)}><Plus />New order</button>}
        {view === 'catalog' && <button className="primary-button" onClick={() => setCatalogDialogItem(null)}><Plus />Add item</button>}
      </div>
    </header>
    <div className="crm-layout">
      <nav className="crm-section-nav" aria-label="CRM sections">{CRM_VIEWS.map((item) => <button key={item.id}
        className={view === item.id ? 'active' : ''} aria-current={view === item.id ? 'page' : undefined}
        onMouseEnter={() => prefetchView(item.id)} onFocus={() => prefetchView(item.id)} onClick={() => changeView(item.id)}>
        {item.icon}<span>{item.label}</span>{item.id === 'leads' && dashboardQuery.data?.openLeads ? <b>{dashboardQuery.data.openLeads}</b> : null}
      </button>)}</nav>
      <section className="crm-content">
        {view === 'overview' && <CrmOverview query={dashboardQuery} onContact={(id) => openCrmContact(id)}
          onView={changeView} />}
        {(view === 'leads' || view === 'customers') && <ContactsView contacts={contactsQuery.data} loading={contactsQuery.isLoading}
          error={contactsQuery.isError} stages={stagesQuery.data ?? []} stageId={stageId} onStage={setStageId}
          onContact={(id) => openCrmContact(id)} onRetry={() => void contactsQuery.refetch()} emptyLabel={view} />}
        {view === 'orders' && <OrdersView orders={ordersQuery.data} contacts={allContactsQuery.data ?? []}
          loading={ordersQuery.isLoading} onEdit={(order) => { setEditingOrder(order); setOrderDialogContactId(order.contactId) }} />}
        {view === 'tasks' && <TasksView tasks={tasksQuery.data} contacts={allContactsQuery.data ?? []}
          loading={tasksQuery.isLoading} onContact={(id) => openCrmContact(id)} />}
        {view === 'catalog' && <CatalogView items={catalogQuery.data} loading={catalogQuery.isLoading}
          onEdit={setCatalogDialogItem} onError={(message) => pushNotice(message)} />}
      </section>
    </div>
    {selectedContactId && <CrmContactPanel contactId={selectedContactId} stages={stagesQuery.data ?? []}
      onClose={() => openCrmContact()} />}
    {taskDialogContactId && <TaskDialog initialContactId={taskDialogContactId} contacts={allContactsQuery.data ?? []}
      onClose={() => setTaskDialogContactId(undefined)} />}
    {orderDialogContactId && <OrderDialog initialContactId={orderDialogContactId} contacts={allContactsQuery.data ?? []}
      catalog={catalogQuery.data?.filter((item) => item.active) ?? []} order={editingOrder}
      onClose={() => { setOrderDialogContactId(undefined); setEditingOrder(undefined) }} />}
    {catalogDialogItem !== undefined && <CatalogDialog item={catalogDialogItem ?? undefined}
      onClose={() => setCatalogDialogItem(undefined)} />}
  </main>
}

function CrmOverview({ query, onContact, onView }: {
  query: { data?: CrmDashboardDto; isLoading: boolean; isError: boolean; refetch(): unknown }
  onContact(id: string): void; onView(view: CrmView): void
}): React.JSX.Element {
  if (query.isLoading) return <CrmLoading label="Loading CRM overview…" />
  if (query.isError || !query.data) return <CrmError label="Could not load the CRM overview" onRetry={() => void query.refetch()} />
  const dashboard = query.data
  const stats = [
    { label: 'New enquiries', value: dashboard.newLeads, detail: `${dashboard.openLeads} active leads`, icon: <BriefcaseBusiness />, view: 'leads' as const },
    { label: 'Customers', value: dashboard.customers, detail: 'Won relationships', icon: <UsersRound />, view: 'customers' as const },
    { label: 'Revenue this month', value: money(dashboard.revenueThisMonth), detail: `${dashboard.ordersThisMonth} orders`, icon: <CircleDollarSign />, view: 'orders' as const },
    { label: 'Overdue follow-ups', value: dashboard.overdueTasks, detail: 'Needs attention', icon: <CalendarClock />, view: 'tasks' as const }
  ]
  return <div className="crm-overview">
    <div className="crm-stat-grid">{stats.map((stat) => <button key={stat.label} className="crm-stat" onClick={() => onView(stat.view)}>
      <span>{stat.icon}</span><div><small>{stat.label}</small><strong>{stat.value}</strong><em>{stat.detail}</em></div><ChevronRight />
    </button>)}</div>
    <div className="crm-overview-grid">
      <section className="crm-card crm-pipeline"><header><div><span>Sales pipeline</span><strong>Enquiries by stage</strong></div>
        <button onClick={() => onView('leads')}>View leads <ChevronRight /></button></header>
        <div>{dashboard.pipeline.map((stage) => <button key={stage.id} onClick={() => onView(stage.outcome === 'won' ? 'customers' : 'leads')}>
          <i style={{ background: stage.color }} /><span><strong>{stage.name}</strong><small>{stage.count} contacts</small></span>
          <b>{money(stage.value)}</b></button>)}</div>
      </section>
      <section className="crm-card crm-recent"><header><div><span>Recent activity</span><strong>Latest contacts</strong></div></header>
        <div>{dashboard.recentContacts.length ? dashboard.recentContacts.map((contact) => <ContactCompactRow key={contact.id}
          contact={contact} onClick={() => onContact(contact.id)} />) : <CrmEmpty icon={<UserRound />} title="No enquiries yet"
            description="New inbound WhatsApp numbers will appear here automatically." />}</div>
      </section>
    </div>
    <section className="crm-card crm-revenue-strip"><span><BadgeIndianRupee /></span><div><small>Recorded lifetime revenue</small>
      <strong>{money(dashboard.lifetimeRevenue)}</strong></div><p>Completed orders are counted here. Quotes and drafts remain in the pipeline without inflating revenue.</p></section>
  </div>
}

function ContactsView({ contacts, loading, error, stages, stageId, onStage, onContact, onRetry, emptyLabel }: {
  contacts?: CrmContactSummaryDto[]; loading: boolean; error: boolean; stages: CrmStageDto[]; stageId: string
  onStage(value: string): void; onContact(id: string): void; onRetry(): void; emptyLabel: 'leads' | 'customers'
}): React.JSX.Element {
  if (loading) return <CrmLoading label={`Loading ${emptyLabel}…`} />
  if (error) return <CrmError label={`Could not load ${emptyLabel}`} onRetry={onRetry} />
  return <div className="crm-list-view">
    {emptyLabel === 'leads' && <div className="crm-filter-row"><button className={!stageId ? 'active' : ''} onClick={() => onStage('')}>All leads</button>
      {stages.map((stage) => <button key={stage.id} className={stageId === stage.id ? 'active' : ''} onClick={() => onStage(stage.id)}>
        <i style={{ background: stage.color }} />{stage.name}</button>)}</div>}
    {!contacts?.length ? <CrmEmpty icon={emptyLabel === 'leads' ? <BriefcaseBusiness /> : <UsersRound />}
      title={`No ${emptyLabel} found`} description={emptyLabel === 'leads'
        ? 'Unsaved numbers that message you will become leads automatically.' : 'Move a lead to Won or record an order to create a customer.'} />
      : <div className="crm-table-card"><table className="crm-table"><thead><tr><th>Contact</th><th>Stage</th><th>Tags</th>
        <th>Orders</th><th>Value</th><th>Follow-ups</th><th>Last activity</th></tr></thead><tbody>{contacts.map((contact) => <tr key={contact.id}
          onClick={() => onContact(contact.id)}><td><ContactCell contact={contact} /></td><td><StagePill contact={contact} /></td>
          <td><TagList contact={contact} /></td><td>{contact.orderCount}</td><td>{money(contact.lifetimeValue)}</td>
          <td>{contact.openTaskCount ? <span className="task-count">{contact.openTaskCount} open</span> : <span className="muted">None</span>}</td>
          <td><RelativeDate value={contact.lastActivityAt} /></td></tr>)}</tbody></table></div>}
  </div>
}

function OrdersView({ orders, contacts, loading, onEdit }: { orders?: CrmOrderDto[]; contacts: CrmContactSummaryDto[]; loading: boolean; onEdit(order: CrmOrderDto): void }): React.JSX.Element {
  const names = useMemo(() => new Map(contacts.map((contact) => [contact.id, contact.name])), [contacts])
  if (loading) return <CrmLoading label="Loading orders…" />
  if (!orders?.length) return <CrmEmpty icon={<ShoppingBag />} title="No orders yet" description="Create an order from a contact record or use New order above." />
  return <div className="crm-table-card"><table className="crm-table"><thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Payment</th><th>Total</th><th>Balance</th><th>Updated</th></tr></thead>
    <tbody>{orders.map((order) => <tr key={order.id} onClick={() => onEdit(order)}><td><strong>{order.orderNumber}</strong><small>{order.items.length} line item{order.items.length === 1 ? '' : 's'}</small></td>
      <td>{names.get(order.contactId) ?? 'Customer'}</td><td><StatusPill value={order.status} /></td><td><StatusPill value={order.paymentStatus} /></td>
      <td><strong>{money(order.total, order.currency)}</strong></td><td>{money(order.balanceAmount, order.currency)}</td><td><RelativeDate value={order.updatedAt} /></td></tr>)}</tbody></table></div>
}

function TasksView({ tasks, contacts, loading, onContact }: { tasks?: CrmTaskDto[]; contacts: CrmContactSummaryDto[]; loading: boolean; onContact(id: string): void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const pushNotice = useUiStore((state) => state.pushNotice)
  const names = useMemo(() => new Map(contacts.map((contact) => [contact.id, contact.name])), [contacts])
  const complete = useMutation({ mutationFn: (task: CrmTaskDto) => window.warish.crm.tasks.save({ ...task, status: 'completed' }),
    onSuccess: (_result, task) => invalidateCrmQueries(queryClient, ['crm', 'tasks'], ['crm', 'contacts'], ['crm', 'dashboard'],
      ['crm', 'contact', task.contactId], ['crm', 'activity', task.contactId]),
    onError: (error) => pushNotice(errorMessage(error)) })
  if (loading) return <CrmLoading label="Loading follow-ups…" />
  if (!tasks?.length) return <CrmEmpty icon={<ListTodo />} title="No follow-ups yet" description="Create tasks to make sure every enquiry gets a timely response." />
  return <div className="crm-task-list">{tasks.map((task) => <article key={task.id} className={`crm-task ${task.status} ${isOverdue(task) ? 'overdue' : ''}`}>
    <button className="crm-task-check" disabled={task.status !== 'open' || complete.isPending} aria-label="Complete task" onClick={() => complete.mutate(task)}>{task.status === 'completed' && <Check />}</button>
    <div><span><strong>{task.title}</strong><PriorityPill value={task.priority} /></span>{task.description && <p>{task.description}</p>}
      <button className="link-button" onClick={() => onContact(task.contactId)}>{names.get(task.contactId) ?? 'Contact'} <ExternalLink /></button></div>
    <time className={isOverdue(task) ? 'danger-text' : ''}>{task.dueAt ? formatDateTime(task.dueAt) : 'No due date'}</time></article>)}</div>
}

function CatalogView({ items, loading, onEdit, onError }: { items?: CrmCatalogItemDto[]; loading: boolean; onEdit(item: CrmCatalogItemDto): void; onError(message: string): void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const archive = useMutation({ mutationFn: (id: string) => window.warish.crm.catalog.delete(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['crm', 'catalog'] }), onError: (error) => onError(errorMessage(error)) })
  if (loading) return <CrmLoading label="Loading catalog…" />
  if (!items?.length) return <CrmEmpty icon={<Package />} title="Your catalog is empty" description="Add reusable products and services, then pull them into orders in one click." />
  return <div className="catalog-grid">{items.map((item) => <article key={item.id} className={`catalog-card ${item.active ? '' : 'inactive'}`}>
    <header><span className="catalog-icon">{item.type === 'product' ? <Package /> : <BriefcaseBusiness />}</span><div><small>{item.type}{item.sku ? ` · ${item.sku}` : ''}</small><strong>{item.name}</strong></div>
      <button className="icon-button" aria-label={`Edit ${item.name}`} onClick={() => onEdit(item)}><Pencil /></button></header>
    {item.description && <p>{item.description}</p>}<footer><strong>{money(item.unitPrice, item.currency)}</strong>{item.active ? <button disabled={archive.isPending}
      onClick={() => archive.mutate(item.id)}><Trash2 />Archive</button> : <span>Archived</span>}</footer></article>)}</div>
}

export function CrmContactPanel({ contactId, stages, onClose, inConversation = false, overviewPrefix, onJumpToMessage,
  persistent = false, overlayOpen = false }: {
  contactId: string
  stages: CrmStageDto[]
  onClose(): void
  inConversation?: boolean
  overviewPrefix?: ReactNode
  onJumpToMessage?(messageId: string): void
  persistent?: boolean
  overlayOpen?: boolean
}): React.JSX.Element {
  const [tab, setTab] = useState<ContactTab>('overview')
  const [editing, setEditing] = useState(false)
  const [contactSaveOpen, setContactSaveOpen] = useState(false)
  const [taskEditor, setTaskEditor] = useState<CrmTaskDto | null>()
  const [orderEditor, setOrderEditor] = useState<CrmOrderDto | null>()
  const queryClient = useQueryClient()
  const pushNotice = useUiStore((state) => state.pushNotice)
  const openChat = useUiStore((state) => state.openChat)
  const contactQuery = useQuery({ queryKey: ['crm', 'contact', contactId], queryFn: () => window.warish.crm.contacts.get({ contactId }) })
  const contact = contactQuery.data
  const whatsappDetailsQuery = useQuery({ queryKey: ['contact', contact?.chatId],
    queryFn: () => window.warish.contacts.get(contact!.chatId), enabled: Boolean(contact?.chatId) })
  const sessionQuery = useQuery({ queryKey: ['session'], queryFn: () => window.warish.session.getState(), staleTime: 30_000 })
  const catalogQuery = useQuery({ queryKey: ['crm', 'catalog'], queryFn: () => window.warish.crm.catalog.list(undefined, false),
    enabled: orderEditor !== undefined })
  const stage = useMutation({ mutationFn: (stageId: string) => window.warish.crm.contacts.setStage(contactId, stageId),
    onSuccess: (contact) => {
      queryClient.setQueryData(['crm', 'contact', contactId], contact)
      queryClient.setQueryData(['crm', 'contact', 'chat', contact.chatId], contact)
      invalidateCrmQueries(queryClient, ['crm', 'contacts'], ['crm', 'dashboard'], ['crm', 'pipeline'])
    },
    onError: (error) => pushNotice(errorMessage(error)) })
  const prefetchTab = useCallback((next: ContactTab): void => {
    if (next === 'notes') void queryClient.prefetchQuery({
      queryKey: ['crm', 'notes', contactId], queryFn: () => window.warish.crm.notes.list(contactId), staleTime: 15_000
    })
    if (next === 'tasks') void queryClient.prefetchQuery({
      queryKey: ['crm', 'tasks', contactId], queryFn: () => window.warish.crm.tasks.list({ contactId }), staleTime: 15_000
    })
    if (next === 'orders') void queryClient.prefetchQuery({
      queryKey: ['crm', 'orders', contactId], queryFn: () => window.warish.crm.orders.list(contactId), staleTime: 15_000
    })
    if (next === 'activity') void queryClient.prefetchQuery({
      queryKey: ['crm', 'activity', contactId], queryFn: () => window.warish.crm.activity(contactId, 100), staleTime: 15_000
    })
  }, [contactId, queryClient])
  useEffect(() => {
    setTab('overview'); setEditing(false); setContactSaveOpen(false); setTaskEditor(undefined); setOrderEditor(undefined)
  }, [contactId])
  return <><aside className={`crm-contact-panel ${inConversation ? 'in-conversation' : ''} ${persistent ? 'persistent-contact-panel' : ''} ${overlayOpen ? 'details-overlay-open' : ''}`} aria-label="CRM contact record"><header><div><span>{inConversation ? 'CRM customer' : 'Contact record'}</span><strong>{inConversation ? 'Customer workspace' : contact?.name ?? 'Loading…'}</strong></div>
    <button className="icon-button contact-panel-close" aria-label="Close customer details" onClick={onClose}><X /></button></header>
    {contactQuery.isError ? <CrmError label="Could not load this customer" onRetry={() => void contactQuery.refetch()} /> : !contact ? <CrmLoading label="Loading contact…" /> : <>
      <div className="crm-contact-hero"><Avatar title={contact.name} src={contact.avatarUrl} large /><div className="crm-contact-copy"><h2>{contact.name}</h2>
        {contact.whatsappName && contact.whatsappName !== contact.name && <span className="whatsapp-profile-pill">{contact.whatsappName}</span>}
        {contact.phoneNumber && <p>{contact.phoneNumber}</p>}</div></div>
      <div className="crm-contact-actions"><button onClick={() => inConversation ? onClose() : openChat(contact.chatId, 'direct')}><MessageCircle />Message</button>
        <button onClick={() => setTaskEditor(null)}><CalendarClock />Task</button><button onClick={() => setOrderEditor(null)}><ShoppingBag />Order</button>
        <button disabled={sessionQuery.data?.phase !== 'connected'} title={sessionQuery.data?.phase === 'connected' ? undefined : 'Connect WhatsApp to save this contact'}
          onClick={() => setContactSaveOpen(true)}><ContactRound />{whatsappDetailsQuery.data?.savedName ? 'Edit contact' : 'Save contact'}</button></div>
      {!inConversation && <label className="crm-stage-select"><span>Pipeline stage</span><select value={contact.stageId} disabled={stage.isPending}
        onChange={(event) => stage.mutate(event.target.value)}>{stages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      }
      <nav className="crm-contact-tabs">{(['overview', 'notes', 'tasks', 'orders', 'activity'] as const).map((item) => <button key={item}
        className={tab === item ? 'active' : ''} onMouseEnter={() => prefetchTab(item)} onFocus={() => prefetchTab(item)}
        onClick={() => setTab(item)}>{item}</button>)}</nav>
      <div className="crm-contact-body">
        {tab === 'overview' && (editing ? <ContactEditForm contact={contact} onDone={() => setEditing(false)} />
          : <ContactProfile contact={contact} onEdit={() => setEditing(true)} prefix={overviewPrefix} />)}
        {tab === 'notes' && <ContactNotes contactId={contactId} onJumpToMessage={onJumpToMessage} />}
        {tab === 'tasks' && <ContactTasks contactId={contactId} onNew={() => setTaskEditor(null)}
          onEdit={(task) => setTaskEditor(task)} onJumpToMessage={onJumpToMessage} />}
        {tab === 'orders' && <ContactOrders contactId={contactId} onNew={() => setOrderEditor(null)}
          onEdit={(order) => setOrderEditor(order)} />}
        {tab === 'activity' && <ContactActivity contactId={contactId} />}
      </div>
      {contactSaveOpen && <WhatsAppContactDialog chatId={contact.chatId}
        initialName={whatsappDetailsQuery.data?.savedName ?? contact.name} phoneNumber={contact.phoneNumber}
        saved={Boolean(whatsappDetailsQuery.data?.savedName)} onClose={() => setContactSaveOpen(false)} />}
    </>}
  </aside>
    {contact && taskEditor !== undefined && <TaskDialog key={taskEditor?.id ?? 'new-task'} initialContactId={contact.id} contacts={[contact]}
      task={taskEditor ?? undefined} onClose={() => setTaskEditor(undefined)} />}
    {contact && orderEditor !== undefined && <OrderDialog key={orderEditor?.id ?? 'new-order'} initialContactId={contact.id} contacts={[contact]}
      catalog={catalogQuery.data ?? []} order={orderEditor ?? undefined} onClose={() => setOrderEditor(undefined)} />}
  </>
}

function ContactProfile({ contact, onEdit, prefix }: { contact: CrmContactDetailsDto; onEdit(): void; prefix?: ReactNode }): React.JSX.Element {
  return <div className="crm-profile-section"><header><strong>Business details</strong><button className="secondary-button" onClick={onEdit}><Pencil />Edit</button></header>
    <dl><ProfileField label="Email" value={contact.email} /><ProfileField label="Company" value={contact.company} />
      <ProfileField label="Address" value={contact.address} /><ProfileField label="Tax ID / GST" value={contact.taxId} />
      <ProfileField label="Birthday" value={contact.birthday} /><ProfileField label="Lead source" value={contact.source} />
      <ProfileField label="Consent" value={contact.consentStatus} /><ProfileField label="Contact preference" value={contact.doNotContact ? 'Do not contact' : contact.preferences} /></dl>
    {contact.tags.length > 0 && <section><small>Tags</small><div className="crm-tags large"><TagList contact={contact} /></div></section>}
    {prefix}
  </div>
}

function ContactEditForm({ contact, onDone }: { contact: CrmContactDetailsDto; onDone(): void }): React.JSX.Element {
  const [form, setForm] = useState(() => ({ name: contact.name, email: contact.email ?? '', company: contact.company ?? '',
    address: contact.address ?? '', taxId: contact.taxId ?? '', birthday: contact.birthday ?? '', source: contact.source,
    preferences: contact.preferences ?? '', consentStatus: contact.consentStatus, doNotContact: contact.doNotContact,
    tags: contact.tags.map((tag) => tag.name).join(', ') }))
  const queryClient = useQueryClient()
  const pushNotice = useUiStore((state) => state.pushNotice)
  const save = useMutation({ mutationFn: () => window.warish.crm.contacts.update(contact.id, { ...form,
    tags: form.tags.split(',').map((name) => ({ name: name.trim() })).filter((tag) => tag.name) }),
    onSuccess: (value) => {
      queryClient.setQueryData(['crm', 'contact', contact.id], value)
      queryClient.setQueryData(['crm', 'contact', 'chat', value.chatId], value)
      invalidateCrmQueries(queryClient, ['crm', 'contacts'], ['crm', 'dashboard'], ['crm', 'activity', contact.id])
      onDone()
    },
    onError: (error) => pushNotice(errorMessage(error)) })
  return <form className="crm-form contact-edit-form" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
    <div className="form-grid"><FormField label="Display name"><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></FormField>
      <FormField label="Email"><input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></FormField>
      <FormField label="Company"><input value={form.company} onChange={(event) => setForm({ ...form, company: event.target.value })} /></FormField>
      <FormField label="Tax ID / GST"><input value={form.taxId} onChange={(event) => setForm({ ...form, taxId: event.target.value })} /></FormField>
      <FormField label="Birthday"><input type="date" value={form.birthday} onChange={(event) => setForm({ ...form, birthday: event.target.value })} /></FormField>
      <FormField label="Lead source"><input value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })} /></FormField></div>
    <FormField label="Address"><textarea value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></FormField>
    <FormField label="Preferences"><textarea value={form.preferences} onChange={(event) => setForm({ ...form, preferences: event.target.value })} /></FormField>
    <FormField label="Tags (comma separated)"><input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} /></FormField>
    <div className="form-grid"><FormField label="Consent"><select value={form.consentStatus} onChange={(event) => setForm({ ...form, consentStatus: event.target.value as typeof form.consentStatus })}>
      <option value="unknown">Unknown</option><option value="granted">Granted</option><option value="denied">Denied</option></select></FormField>
      <label className="checkbox-field"><input type="checkbox" checked={form.doNotContact} onChange={(event) => setForm({ ...form, doNotContact: event.target.checked })} />Do not contact</label></div>
    <footer><button type="button" className="secondary-button" onClick={onDone}>Cancel</button><button className="primary-button" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save contact'}</button></footer>
  </form>
}

function ContactNotes({ contactId, onJumpToMessage }: { contactId: string; onJumpToMessage?(messageId: string): void }): React.JSX.Element {
  const [body, setBody] = useState('')
  const [editing, setEditing] = useState<CrmNoteDto>()
  const queryClient = useQueryClient()
  const pushNotice = useUiStore((state) => state.pushNotice)
  const query = useQuery({ queryKey: ['crm', 'notes', contactId], queryFn: () => window.warish.crm.notes.list(contactId) })
  const save = useMutation({ mutationFn: () => window.warish.crm.notes.save({ id: editing?.id, contactId, body,
    sourceMessageId: editing?.sourceMessageId }), onSuccess: () => {
    setBody(''); setEditing(undefined); invalidateCrmQueries(queryClient, ['crm', 'notes', contactId], ['crm', 'activity', contactId],
      ['crm', 'contact', contactId], ['crm', 'contacts'], ['crm', 'dashboard'])
  }, onError: (error) => pushNotice(errorMessage(error)) })
  const remove = useMutation({ mutationFn: (noteId: string) => window.warish.crm.notes.delete(noteId), onSuccess: () => {
    invalidateCrmQueries(queryClient, ['crm', 'notes', contactId], ['crm', 'activity', contactId],
      ['crm', 'contact', contactId], ['crm', 'contacts'], ['crm', 'dashboard'])
  }, onError: (error) => pushNotice(errorMessage(error)) })
  const edit = (note: CrmNoteDto): void => { setEditing(note); setBody(note.body) }
  return <div className="crm-note-section"><form onSubmit={(event) => { event.preventDefault(); if (body.trim()) save.mutate() }}><textarea value={body}
    onChange={(event) => setBody(event.target.value)} placeholder="Add customer context" /><div className="crm-inline-form-actions">
      {editing && <button type="button" className="secondary-button" onClick={() => { setEditing(undefined); setBody('') }}>Cancel</button>}
      <button className="primary-button" disabled={!body.trim() || save.isPending}><NotebookPen />{editing ? 'Save note' : 'Add note'}</button></div></form>
    <div className="crm-note-list">{query.data?.map((note) => <article key={note.id}><p>{note.body}</p>
      {note.sourceMessage && <MessageReference reference={note.sourceMessage} onJump={onJumpToMessage} />}
      <footer><time>{formatDateTime(note.createdAt)}</time><span><button className="icon-button" aria-label="Edit note" onClick={() => edit(note)}><Pencil /></button>
        <button className="icon-button danger-text" aria-label="Delete note" disabled={remove.isPending} onClick={() => remove.mutate(note.id)}><Trash2 /></button></span></footer></article>)}
      {!query.isLoading && !query.data?.length && <CrmEmpty icon={<FileText />} title="No notes yet" description="Keep useful customer context here." />}</div></div>
}

function ContactOrders({ contactId, onNew, onEdit }: { contactId: string; onNew(): void; onEdit(order: CrmOrderDto): void }): React.JSX.Element {
  const query = useQuery({ queryKey: ['crm', 'orders', contactId], queryFn: () => window.warish.crm.orders.list(contactId) })
  return <div><button className="primary-button contact-tab-action" onClick={onNew}><Plus />New order</button>{query.data?.map((order) => <button className="contact-order" key={order.id} onClick={() => onEdit(order)}>
    <span><strong>{order.orderNumber}</strong><small>{formatDateTime(order.createdAt)}</small></span><StatusPill value={order.status} /><b>{money(order.total, order.currency)}</b><Pencil /></button>)}
    {!query.isLoading && !query.data?.length && <CrmEmpty icon={<ShoppingBag />} title="No purchase history" description="Orders for this contact will appear here." />}</div>
}

function ContactTasks({ contactId, onNew, onEdit, onJumpToMessage }: { contactId: string; onNew(): void; onEdit(task: CrmTaskDto): void; onJumpToMessage?(messageId: string): void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const pushNotice = useUiStore((state) => state.pushNotice)
  const query = useQuery({ queryKey: ['crm', 'tasks', contactId], queryFn: () => window.warish.crm.tasks.list({ contactId }) })
  const complete = useMutation({ mutationFn: (task: CrmTaskDto) => window.warish.crm.tasks.save({ ...task,
    status: task.status === 'completed' ? 'open' : 'completed' }), onSuccess: () => {
    invalidateCrmQueries(queryClient, ['crm', 'tasks'], ['crm', 'activity', contactId],
      ['crm', 'contact', contactId], ['crm', 'contacts'], ['crm', 'dashboard'])
  }, onError: (error) => pushNotice(errorMessage(error)) })
  const remove = useMutation({ mutationFn: (taskId: string) => window.warish.crm.tasks.delete(taskId), onSuccess: () => {
    invalidateCrmQueries(queryClient, ['crm', 'tasks'], ['crm', 'activity', contactId],
      ['crm', 'contact', contactId], ['crm', 'contacts'], ['crm', 'dashboard'])
  }, onError: (error) => pushNotice(errorMessage(error)) })
  return <div><button className="primary-button contact-tab-action" onClick={onNew}><Plus />New task</button>{query.data?.map((task) => <article className="contact-task" key={task.id}>
    <button className={task.status === 'completed' ? 'checked' : ''} aria-label={task.status === 'completed' ? 'Reopen task' : 'Complete task'}
      disabled={complete.isPending} onClick={() => complete.mutate(task)}>{task.status === 'completed' && <Check />}</button>
    <button className="contact-task-copy" onClick={() => onEdit(task)}><strong>{task.title}</strong><small>{task.dueAt ? formatDateTime(task.dueAt) : 'No due date'}</small></button>
    <PriorityPill value={task.priority} /><button className="icon-button danger-text" aria-label="Delete task" disabled={remove.isPending} onClick={() => remove.mutate(task.id)}><Trash2 /></button>
    {task.sourceMessage && <MessageReference reference={task.sourceMessage} onJump={onJumpToMessage} />}</article>)}
    {!query.isLoading && !query.data?.length && <CrmEmpty icon={<ListTodo />} title="No follow-ups" description="Create a task so this relationship does not go cold." />}</div>
}

function ContactActivity({ contactId }: { contactId: string }): React.JSX.Element {
  const query = useQuery({ queryKey: ['crm', 'activity', contactId], queryFn: () => window.warish.crm.activity(contactId, 100) })
  return <div className="crm-timeline">{query.data?.map((activity) => <article key={activity.id}><i /><div><strong>{activity.summary}</strong><time>{formatDateTime(activity.createdAt)}</time></div></article>)}
    {!query.isLoading && !query.data?.length && <CrmEmpty icon={<RefreshCw />} title="No activity yet" description="CRM changes will be recorded here." />}</div>
}

function MessageReference({ reference, onJump }: { reference: CrmMessageReferenceDto; onJump?(messageId: string): void }): React.JSX.Element {
  return <div className="crm-message-reference"><MessageCircle /><span><small>{reference.fromMe ? 'You' : reference.senderName ?? 'Customer'} · {formatDateTime(reference.timestamp)}</small>
    <strong>{reference.text ?? reference.kind}</strong></span>{onJump && <button className="icon-button" title="Show source message" aria-label="Show source message"
      onClick={() => onJump(reference.messageId)}><ExternalLink /></button>}</div>
}

function TaskDialog({ initialContactId, contacts, task, onClose }: { initialContactId: string; contacts: CrmContactSummaryDto[]; task?: CrmTaskDto; onClose(): void }): React.JSX.Element {
  const [contactId, setContactId] = useState(initialContactId)
  const [title, setTitle] = useState(task?.title ?? 'Follow up on WhatsApp')
  const [description, setDescription] = useState(task?.description ?? '')
  const [due, setDue] = useState(task?.dueAt ? toLocalInput(task.dueAt) : toLocalInput(Date.now() + 24 * 60 * 60 * 1000))
  const [priority, setPriority] = useState<CrmTaskDto['priority']>(task?.priority ?? 'normal')
  const [status, setStatus] = useState<CrmTaskDto['status']>(task?.status ?? 'open')
  const queryClient = useQueryClient()
  const pushNotice = useUiStore((state) => state.pushNotice)
  const save = useMutation({ mutationFn: () => window.warish.crm.tasks.save({ id: task?.id, contactId, title, description,
    dueAt: due ? new Date(due).getTime() : undefined, priority, status, sourceMessageId: task?.sourceMessageId }), onSuccess: () => {
    invalidateCrmQueries(queryClient, ['crm', 'tasks'], ['crm', 'activity', contactId], ['crm', 'contact', contactId],
      ['crm', 'contacts'], ['crm', 'dashboard']); onClose()
  },
    onError: (error) => pushNotice(errorMessage(error)) })
  const remove = useMutation({ mutationFn: () => window.warish.crm.tasks.delete(task!.id), onSuccess: () => {
    invalidateCrmQueries(queryClient, ['crm', 'tasks'], ['crm', 'activity', contactId], ['crm', 'contact', contactId],
      ['crm', 'contacts'], ['crm', 'dashboard']); onClose()
  }, onError: (error) => pushNotice(errorMessage(error)) })
  return <CrmDialog title={task ? 'Edit follow-up' : 'New follow-up'} eyebrow="Task" onClose={onClose}><form className="crm-form" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
    <FormField label="Contact"><select value={contactId} disabled={Boolean(task)} onChange={(event) => setContactId(event.target.value)} required>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}{contact.phoneNumber ? ` · ${contact.phoneNumber}` : ''}</option>)}</select></FormField>
    <FormField label="Task"><input value={title} onChange={(event) => setTitle(event.target.value)} required autoFocus /></FormField>
    <FormField label="Notes"><textarea value={description} onChange={(event) => setDescription(event.target.value)} /></FormField>
    <div className="form-grid"><FormField label="Due"><input type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} /></FormField>
      <FormField label="Priority"><select value={priority} onChange={(event) => setPriority(event.target.value as CrmTaskDto['priority'])}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></FormField></div>
    {task && <FormField label="Status"><select value={status} onChange={(event) => setStatus(event.target.value as CrmTaskDto['status'])}><option value="open">Open</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></FormField>}
    <footer>{task && <button type="button" className="danger-button crm-delete-button" disabled={remove.isPending} onClick={() => remove.mutate()}><Trash2 />Delete</button>}
      <button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!contactId || save.isPending}>{save.isPending ? 'Saving…' : task ? 'Save task' : 'Create task'}</button></footer>
  </form></CrmDialog>
}

interface OrderLine { catalogItemId?: string; type: 'product' | 'service'; name: string; quantity: number; unitPrice: number; discount: number; taxRate: number }
function OrderDialog({ initialContactId, contacts, catalog, order, onClose }: { initialContactId: string; contacts: CrmContactSummaryDto[]; catalog: CrmCatalogItemDto[]; order?: CrmOrderDto; onClose(): void }): React.JSX.Element {
  const [contactId, setContactId] = useState(order?.contactId ?? initialContactId)
  const [status, setStatus] = useState<CrmOrderInput['status']>(order?.status ?? 'draft')
  const [lines, setLines] = useState<OrderLine[]>(() => order?.items.map((item) => ({ catalogItemId: item.catalogItemId, type: item.type,
    name: item.name, quantity: item.quantity, unitPrice: item.unitPrice, discount: item.discount, taxRate: item.taxRate })) ??
    [{ type: 'product', name: '', quantity: 1, unitPrice: 0, discount: 0, taxRate: 0 }])
  const [paidAmount, setPaidAmount] = useState(order?.paidAmount ?? 0)
  const [internalNote, setInternalNote] = useState(order?.internalNote ?? '')
  const queryClient = useQueryClient()
  const pushNotice = useUiStore((state) => state.pushNotice)
  const total = lines.reduce((sum, line) => sum + Math.max(0, line.quantity * line.unitPrice - line.discount) * (1 + line.taxRate / 100), 0)
  const save = useMutation({ mutationFn: () => window.warish.crm.orders.save({ id: order?.id, contactId, status, currency: 'INR',
    internalNote, items: lines, payments: order && paidAmount === order.paidAmount ? undefined
      : paidAmount > 0 ? [{ amount: paidAmount, paidAt: Date.now(), method: 'manual' }] : [] }),
    onSuccess: () => {
      invalidateCrmQueries(queryClient, ['crm', 'orders'], ['crm', 'activity', contactId], ['crm', 'contact', contactId],
        ['crm', 'contacts'], ['crm', 'dashboard']); onClose()
    }, onError: (error) => pushNotice(errorMessage(error)) })
  const remove = useMutation({ mutationFn: () => window.warish.crm.orders.delete(order!.id), onSuccess: () => {
    invalidateCrmQueries(queryClient, ['crm', 'orders'], ['crm', 'activity', contactId], ['crm', 'contact', contactId],
      ['crm', 'contacts'], ['crm', 'dashboard']); onClose()
  }, onError: (error) => pushNotice(errorMessage(error)) })
  const updateLine = (index: number, patch: Partial<OrderLine>): void => setLines((current) => current.map((line, position) => position === index ? { ...line, ...patch } : line))
  const chooseCatalog = (index: number, id: string): void => {
    const item = catalog.find((entry) => entry.id === id)
    if (!item) { updateLine(index, { catalogItemId: undefined }); return }
    updateLine(index, { catalogItemId: item.id, type: item.type, name: item.name, unitPrice: item.unitPrice })
  }
  return <CrmDialog title={order ? order.orderNumber : 'New order'} eyebrow={order ? 'Edit order' : 'Order'} onClose={onClose} wide><form className="crm-form order-form" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
    <div className="form-grid"><FormField label="Customer"><select value={contactId} disabled={Boolean(order)} onChange={(event) => setContactId(event.target.value)} required>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}</select></FormField>
      <FormField label="Status"><select value={status} onChange={(event) => setStatus(event.target.value as CrmOrderInput['status'])}><option value="draft">Draft</option><option value="confirmed">Confirmed</option><option value="in-progress">In progress</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></FormField></div>
    <div className="order-lines"><header><strong>Line items</strong><button type="button" onClick={() => setLines([...lines, { type: 'product', name: '', quantity: 1, unitPrice: 0, discount: 0, taxRate: 0 }])}><Plus />Add line</button></header>
      {lines.map((line, index) => <div className="order-line" key={index}><select aria-label="Catalog item" value={line.catalogItemId ?? ''} onChange={(event) => chooseCatalog(index, event.target.value)}><option value="">Custom item</option>{catalog.map((item) => <option key={item.id} value={item.id}>{item.name} · {money(item.unitPrice)}</option>)}</select>
        <input aria-label="Item name" placeholder="Product or service" value={line.name} onChange={(event) => updateLine(index, { name: event.target.value })} required />
        <select aria-label="Item type" value={line.type} onChange={(event) => updateLine(index, { type: event.target.value as OrderLine['type'] })}><option value="product">Product</option><option value="service">Service</option></select>
        <label>Qty<input type="number" min="0.001" step="0.001" value={line.quantity} onChange={(event) => updateLine(index, { quantity: Number(event.target.value) })} /></label>
        <label>Rate<input type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => updateLine(index, { unitPrice: Number(event.target.value) })} /></label>
        <label>Discount<input type="number" min="0" step="0.01" value={line.discount} onChange={(event) => updateLine(index, { discount: Number(event.target.value) })} /></label>
        <label>Tax %<input type="number" min="0" max="100" step="0.01" value={line.taxRate} onChange={(event) => updateLine(index, { taxRate: Number(event.target.value) })} /></label>
        <strong>{money(Math.max(0, line.quantity * line.unitPrice - line.discount) * (1 + line.taxRate / 100))}</strong>
        <button type="button" className="icon-button" aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, position) => position !== index))}><Trash2 /></button></div>)}</div>
    <div className="order-footer-grid"><FormField label="Internal note"><textarea value={internalNote} onChange={(event) => setInternalNote(event.target.value)} /></FormField>
      <div><FormField label="Payment received"><input type="number" min="0" step="0.01" value={paidAmount} onChange={(event) => setPaidAmount(Number(event.target.value))} /></FormField>
        <div className="order-total"><span>Order total</span><strong>{money(total)}</strong></div></div></div>
    <footer>{order && <button type="button" className="danger-button crm-delete-button" disabled={remove.isPending} onClick={() => remove.mutate()}><Trash2 />Delete</button>}
      <button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!contactId || lines.some((line) => !line.name.trim()) || save.isPending}>{save.isPending ? 'Saving…' : 'Save order'}</button></footer>
  </form></CrmDialog>
}

function CatalogDialog({ item, onClose }: { item?: CrmCatalogItemDto; onClose(): void }): React.JSX.Element {
  const [type, setType] = useState<CrmCatalogItemDto['type']>(item?.type ?? 'product')
  const [name, setName] = useState(item?.name ?? '')
  const [sku, setSku] = useState(item?.sku ?? '')
  const [description, setDescription] = useState(item?.description ?? '')
  const [unitPrice, setUnitPrice] = useState(item?.unitPrice ?? 0)
  const [active, setActive] = useState(item?.active ?? true)
  const queryClient = useQueryClient()
  const pushNotice = useUiStore((state) => state.pushNotice)
  const save = useMutation({ mutationFn: () => window.warish.crm.catalog.save({ id: item?.id, type, name, sku, description,
    unitPrice, currency: 'INR', active }), onSuccess: () => { invalidateCrmQueries(queryClient, ['crm', 'catalog']); onClose() },
    onError: (error) => pushNotice(errorMessage(error)) })
  return <CrmDialog title={item ? 'Edit catalog item' : 'Add catalog item'} eyebrow="Catalog" onClose={onClose}><form className="crm-form" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
    <div className="form-grid"><FormField label="Type"><select value={type} onChange={(event) => setType(event.target.value as typeof type)}><option value="product">Product</option><option value="service">Service</option></select></FormField>
      <FormField label="SKU / code"><input value={sku} onChange={(event) => setSku(event.target.value)} /></FormField></div>
    <FormField label="Name"><input value={name} onChange={(event) => setName(event.target.value)} required autoFocus /></FormField>
    <FormField label="Description"><textarea value={description} onChange={(event) => setDescription(event.target.value)} /></FormField>
    <div className="form-grid"><FormField label="Unit price (INR)"><input type="number" min="0" step="0.01" value={unitPrice} onChange={(event) => setUnitPrice(Number(event.target.value))} required /></FormField>
      <label className="checkbox-field"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />Available for new orders</label></div>
    <footer><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save item'}</button></footer>
  </form></CrmDialog>
}

function CrmDialog({ title, eyebrow, wide, onClose, children }: { title: string; eyebrow: string; wide?: boolean; onClose(): void; children: ReactNode }): React.JSX.Element {
  return <div className="modal-backdrop crm-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className={`modal crm-dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
    <header><div><span>{eyebrow}</span><h2>{title}</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}><X /></button></header><div className="crm-dialog-body">{children}</div></section></div>
}

function ContactCompactRow({ contact, onClick }: { contact: CrmContactSummaryDto; onClick(): void }): React.JSX.Element {
  return <button className="contact-compact-row" onClick={onClick}><Avatar title={contact.name} src={contact.avatarUrl} /><span><strong>{contact.name}</strong>
    <small>{contact.phoneNumber ?? contact.company ?? 'WhatsApp enquiry'}</small></span><StagePill contact={contact} /><ChevronRight /></button>
}
function ContactCell({ contact }: { contact: CrmContactSummaryDto }): React.JSX.Element {
  return <span className="crm-contact-cell"><Avatar title={contact.name} src={contact.avatarUrl} /><span><strong>{contact.name}</strong><small>{contact.phoneNumber ?? contact.company ?? contact.whatsappName ?? 'WhatsApp contact'}</small></span></span>
}
function StagePill({ contact }: { contact: Pick<CrmContactSummaryDto, 'stageName' | 'stageColor'> }): React.JSX.Element {
  return <span className="stage-pill" style={{ '--stage-color': contact.stageColor } as React.CSSProperties}><i />{contact.stageName}</span>
}
function TagList({ contact }: { contact: Pick<CrmContactSummaryDto, 'tags'> }): React.JSX.Element {
  if (!contact.tags.length) return <span className="muted">—</span>
  return <span className="crm-tags">{contact.tags.slice(0, 3).map((tag) => <span key={tag.id} style={{ '--tag-color': tag.color } as React.CSSProperties}>{tag.name}</span>)}
    {contact.tags.length > 3 && <b>+{contact.tags.length - 3}</b>}</span>
}
function StatusPill({ value }: { value: string }): React.JSX.Element { return <span className={`status-pill ${value}`}>{value.replace('-', ' ')}</span> }
function PriorityPill({ value }: { value: CrmTaskDto['priority'] }): React.JSX.Element { return <span className={`priority-pill ${value}`}>{value}</span> }
function ProfileField({ label, value }: { label: string; value?: string }): React.JSX.Element { return <div><dt>{label}</dt><dd>{value || 'Not added'}</dd></div> }
function FormField({ label, children }: { label: string; children: ReactNode }): React.JSX.Element { return <label className="form-field"><span>{label}</span>{children}</label> }
function RelativeDate({ value }: { value: number }): React.JSX.Element { return <time title={formatDateTime(value)}>{relativeDate(value)}</time> }
function CrmLoading({ label }: { label: string }): React.JSX.Element { return <div className="crm-state"><LoaderCircle className="spin" /><span>{label}</span></div> }
function CrmError({ label, onRetry }: { label: string; onRetry(): void }): React.JSX.Element { return <div className="crm-state error-text"><span>{label}</span><button className="secondary-button" onClick={onRetry}><RefreshCw />Try again</button></div> }
function CrmEmpty({ icon, title, description }: { icon: ReactNode; title: string; description: string }): React.JSX.Element { return <div className="crm-empty">{icon}<strong>{title}</strong><p>{description}</p></div> }

const currencyFormatter = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 })
function money(value: number, currency = 'INR'): string {
  if (currency === 'INR') return currencyFormatter.format(value)
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value)
}
function relativeDate(value: number): string {
  const difference = Date.now() - value
  if (difference < 60_000) return 'Just now'
  if (difference < 60 * 60_000) return `${Math.floor(difference / 60_000)}m ago`
  if (difference < 24 * 60 * 60_000) return `${Math.floor(difference / (60 * 60_000))}h ago`
  if (difference < 7 * 24 * 60 * 60_000) return `${Math.floor(difference / (24 * 60 * 60_000))}d ago`
  return new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}
function formatDateTime(value: number): string { return new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) }
function isOverdue(task: CrmTaskDto): boolean { return task.status === 'open' && Boolean(task.dueAt && task.dueAt < Date.now()) }
function invalidateCrmQueries(queryClient: QueryClient, ...queryKeys: QueryKey[]): void {
  void Promise.all(queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })))
}
function toLocalInput(value: number): string {
  const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 16)
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'The CRM action could not be completed' }
