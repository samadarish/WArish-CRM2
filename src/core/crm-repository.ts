import { randomUUID } from 'node:crypto'
import type {
  CoreEventEnvelope,
  CrmActivityDto,
  CrmCatalogItemDto,
  CrmContactDetailsDto,
  CrmContactPatch,
  CrmContactSummaryDto,
  CrmDashboardDto,
  CrmLifecycle,
  CrmMessageReferenceDto,
  CrmNoteDto,
  CrmNoteInput,
  CrmOrderDto,
  CrmOrderInput,
  CrmOrderItemDto,
  CrmPaymentDto,
  CrmStageDto,
  CrmStageKey,
  CrmTagDto,
  CrmTaskDto,
  CrmTaskInput
} from '../shared/contracts'
import { WarishDatabase } from './database'

type EmitEvent = (event: CoreEventEnvelope) => void
type Row = Record<string, unknown>
type SqlValue = string | number | bigint | Uint8Array | null

const CONTACT_SELECT = `
  SELECT crm.*, stage.key AS stage_key, stage.name AS stage_name, stage.color AS stage_color,
    identity.saved_name, identity.whatsapp_name, identity.phone_number, identity.avatar_token,
    chats.title AS chat_title,
    (SELECT COUNT(*) FROM crm_orders orders WHERE orders.contact_id=crm.id AND orders.status!='cancelled') AS order_count,
    (SELECT COALESCE(SUM(orders.total), 0) FROM crm_orders orders
      WHERE orders.contact_id=crm.id AND orders.status='completed') AS lifetime_value,
    (SELECT COUNT(*) FROM crm_tasks tasks WHERE tasks.contact_id=crm.id AND tasks.status='open') AS open_task_count
  FROM crm_contacts crm
  JOIN crm_pipeline_stages stage ON stage.id=crm.stage_id
  LEFT JOIN contact_identities identity ON identity.identity_id=crm.identity_id
  LEFT JOIN chats ON chats.id=crm.chat_id`

export class ContactRestrictedError extends Error {
  constructor(name: string, reasons: string[]) {
    super(`Confirmation required before contacting ${name}: ${reasons.join(' and ')}.`)
    this.name = 'ContactRestrictedError'
  }
}

/** Local-first CRM operations. All business data stays inside the same local application data boundary as WhatsApp. */
export class CrmRepository {
  readonly #database: WarishDatabase
  readonly #emit: EmitEvent

  constructor(database: WarishDatabase, emit: EmitEvent) {
    this.#database = database
    this.#emit = emit
  }

  pipeline(): CrmStageDto[] {
    return (this.#database.db.prepare('SELECT * FROM crm_pipeline_stages ORDER BY position, id').all() as Row[])
      .map(mapStage)
  }

  dashboard(): CrmDashboardDto {
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const counts = this.#database.db.prepare(`
      SELECT
        SUM(CASE WHEN lifecycle='lead' AND stage_id='stage-new' THEN 1 ELSE 0 END) AS new_leads,
        SUM(CASE WHEN lifecycle='lead' AND stage_id NOT IN ('stage-won','stage-lost') THEN 1 ELSE 0 END) AS open_leads,
        SUM(CASE WHEN lifecycle='customer' THEN 1 ELSE 0 END) AS customers
      FROM crm_contacts
    `).get() as Row
    const overdue = this.#database.db.prepare(
      "SELECT COUNT(*) AS count FROM crm_tasks WHERE status='open' AND due_at IS NOT NULL AND due_at<?"
    ).get(Date.now()) as Row
    const orders = this.#database.db.prepare(`
      SELECT
        SUM(CASE WHEN created_at>=? AND status!='cancelled' THEN 1 ELSE 0 END) AS month_count,
        SUM(CASE WHEN completed_at>=? AND status='completed' THEN total ELSE 0 END) AS month_revenue,
        SUM(CASE WHEN status='completed' THEN total ELSE 0 END) AS lifetime_revenue
      FROM crm_orders
    `).get(monthStart, monthStart) as Row
    const pipeline = this.#database.db.prepare(`
      SELECT stage.*, COUNT(crm.id) AS contact_count,
        COALESCE(SUM(order_totals.pipeline_value), 0) AS pipeline_value
      FROM crm_pipeline_stages stage
      LEFT JOIN crm_contacts crm ON crm.stage_id=stage.id AND crm.lifecycle IN ('lead','customer')
      LEFT JOIN (
        SELECT contact_id, SUM(total) AS pipeline_value FROM crm_orders
        WHERE status!='cancelled' GROUP BY contact_id
      ) order_totals ON order_totals.contact_id=crm.id
      GROUP BY stage.id ORDER BY stage.position, stage.id
    `).all() as Row[]
    return {
      newLeads: numberValue(counts.new_leads),
      openLeads: numberValue(counts.open_leads),
      customers: numberValue(counts.customers),
      overdueTasks: numberValue(overdue.count),
      ordersThisMonth: numberValue(orders.month_count),
      revenueThisMonth: numberValue(orders.month_revenue),
      lifetimeRevenue: numberValue(orders.lifetime_revenue),
      recentContacts: this.listContacts({ lifecycle: 'active', limit: 8 }),
      pipeline: pipeline.map((row) => ({ ...mapStage(row), count: numberValue(row.contact_count), value: numberValue(row.pipeline_value) }))
    }
  }

  listContacts(input: { lifecycle?: CrmLifecycle | 'active'; stageId?: string; query?: string; limit?: number } = {}): CrmContactSummaryDto[] {
    const conditions: string[] = []
    const values: SqlValue[] = []
    if (input.lifecycle === 'active') conditions.push("crm.lifecycle IN ('lead','customer')")
    else if (input.lifecycle) { conditions.push('crm.lifecycle=?'); values.push(input.lifecycle) }
    if (input.stageId) { conditions.push('crm.stage_id=?'); values.push(input.stageId) }
    const query = input.query?.trim()
    if (query) {
      const like = `%${escapeLike(query)}%`
      conditions.push(`(crm.name LIKE ? ESCAPE '\\' OR crm.email LIKE ? ESCAPE '\\' OR crm.company LIKE ? ESCAPE '\\'
        OR identity.saved_name LIKE ? ESCAPE '\\' OR identity.whatsapp_name LIKE ? ESCAPE '\\'
        OR identity.phone_number LIKE ? ESCAPE '\\' OR chats.title LIKE ? ESCAPE '\\')`)
      values.push(like, like, like, like, like, like, like)
    }
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 200)))
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.#database.db.prepare(`${CONTACT_SELECT}${where} ORDER BY crm.last_activity_at DESC, crm.id LIMIT ?`)
      .all(...values, limit) as Row[]
    return this.#mapContacts(rows)
  }

  getContact(input: { contactId?: string; chatId?: string }): CrmContactDetailsDto {
    let row: Row | undefined
    if (input.contactId) row = this.#database.db.prepare(`${CONTACT_SELECT} WHERE crm.id=?`).get(input.contactId) as Row | undefined
    else if (input.chatId) {
      const chatId = this.#database.resolveChatId(input.chatId)
      row = this.#database.db.prepare(`${CONTACT_SELECT} WHERE crm.chat_id=? OR crm.identity_id=(
        SELECT identity_id FROM contact_identity_aliases WHERE alias_id=?
      ) ORDER BY crm.updated_at DESC LIMIT 1`).get(chatId, chatId) as Row | undefined
    }
    if (!row) throw new Error('CRM contact not found')
    return this.#mapContactDetails(row)
  }

  assertCanContact(chatIdInput: string, acknowledged: boolean): void {
    const chatId = this.#database.resolveChatId(chatIdInput)
    const row = this.#database.db.prepare(`SELECT crm.name, crm.do_not_contact, crm.consent_status,
      identity.saved_name, identity.whatsapp_name, identity.phone_number, chats.title AS chat_title
      FROM crm_contacts crm
      LEFT JOIN contact_identities identity ON identity.identity_id=crm.identity_id
      LEFT JOIN chats ON chats.id=crm.chat_id
      WHERE crm.chat_id=? OR crm.identity_id=(SELECT identity_id FROM contact_identity_aliases WHERE alias_id=?)
      ORDER BY crm.updated_at DESC LIMIT 1`).get(chatId, chatId) as Row | undefined
    if (!row) return
    const reasons = [row.do_not_contact ? 'the contact is marked do not contact' : undefined,
      row.consent_status === 'denied' ? 'consent is denied' : undefined].filter((reason): reason is string => Boolean(reason))
    if (reasons.length && !acknowledged) {
      const phone = formatPhone(textValue(row.phone_number))
      const name = textValue(row.name) ?? textValue(row.saved_name) ?? textValue(row.whatsapp_name) ??
        usableName(textValue(row.chat_title), phone) ?? phone ?? 'this contact'
      throw new ContactRestrictedError(name, reasons)
    }
  }

  ensureContact(chatIdInput: string, source = 'manual'): CrmContactDetailsDto {
    const chatId = this.#database.resolveChatId(chatIdInput)
    const existing = this.#findByChat(chatId)
    if (existing) return this.#mapContactDetails(existing)
    const identityId = this.#database.ensureCanonicalContact(chatId)
    const chat = this.#database.getContactDetails(chatId)
    if (chat.kind !== 'direct') throw new Error('Only direct WhatsApp conversations can become CRM contacts')
    const now = Date.now()
    const id = randomUUID()
    this.#database.db.prepare(`
      INSERT INTO crm_contacts(id, identity_id, chat_id, lifecycle, stage_id, source, created_at, last_activity_at, updated_at)
      VALUES (?, ?, ?, 'lead', 'stage-new', ?, ?, ?, ?)
    `).run(id, identityId, chatId, cleanText(source, 80) || 'manual', now, now, now)
    this.#addActivity(id, 'lead-created', source === 'manual' ? 'Added to CRM' : 'New WhatsApp enquiry')
    this.#changed({ contactId: id, chatId, scope: 'pipeline' })
    return this.getContact({ contactId: id })
  }

  /** Creates a lead only for recent inbound direct messages from numbers not already saved in WhatsApp. */
  ensureInboundLead(chatIdInput: string, occurredAt: number, notify = true): boolean {
    if (!Number.isFinite(occurredAt) || occurredAt < Date.now() - 90 * 24 * 60 * 60 * 1000) return false
    const chatId = this.#database.resolveChatId(chatIdInput)
    let identityId: string
    try { identityId = this.#database.ensureCanonicalContact(chatId) }
    catch { return false }
    const identity = this.#database.db.prepare(`
      SELECT chats.kind, contact.saved_name FROM chats
      LEFT JOIN contact_identities contact ON contact.identity_id=? WHERE chats.id=?
    `).get(identityId, chatId) as Row | undefined
    if (!identity || identity.kind !== 'direct' || textValue(identity.saved_name)) return false
    const existing = this.#findByIdentity(identityId)
    if (existing) {
      const lastActivity = Math.max(numberValue(existing.last_activity_at), occurredAt)
      if (lastActivity !== numberValue(existing.last_activity_at) || existing.chat_id !== chatId) {
        this.#database.db.prepare('UPDATE crm_contacts SET chat_id=?, last_activity_at=?, updated_at=? WHERE id=?')
          .run(chatId, lastActivity, Date.now(), String(existing.id))
      }
      return false
    }
    const id = randomUUID()
    this.#database.transaction(() => {
      this.#database.db.prepare(`
        INSERT INTO crm_contacts(id, identity_id, chat_id, lifecycle, stage_id, source, created_at, last_activity_at, updated_at)
        VALUES (?, ?, ?, 'lead', 'stage-new', 'whatsapp', ?, ?, ?)
      `).run(id, identityId, chatId, occurredAt, occurredAt, Date.now())
      this.#addActivity(id, 'lead-created', 'New WhatsApp enquiry', { chatId })
    })
    if (notify) this.#changed({ contactId: id, chatId, scope: 'pipeline' })
    return true
  }

  updateContact(contactId: string, patch: CrmContactPatch): CrmContactDetailsDto {
    this.getContact({ contactId })
    const assignments: string[] = []
    const values: SqlValue[] = []
    const textColumns: Array<[keyof CrmContactPatch, string, number]> = [
      ['name', 'name', 160], ['email', 'email', 254], ['company', 'company', 160], ['address', 'address', 1_000],
      ['birthday', 'birthday', 40], ['taxId', 'tax_id', 80], ['preferences', 'preferences', 2_000], ['source', 'source', 80]
    ]
    for (const [key, column, max] of textColumns) {
      if (!(key in patch)) continue
      assignments.push(`${column}=?`)
      values.push(cleanText(patch[key] as string | undefined, max) || null)
    }
    if ('consentStatus' in patch && patch.consentStatus) { assignments.push('consent_status=?'); values.push(patch.consentStatus) }
    if ('doNotContact' in patch) { assignments.push('do_not_contact=?'); values.push(Number(Boolean(patch.doNotContact))) }
    if ('customFields' in patch) {
      assignments.push('custom_fields=?')
      values.push(JSON.stringify(cleanCustomFields(patch.customFields)))
    }
    this.#database.transaction(() => {
      if (assignments.length) this.#database.db.prepare(`UPDATE crm_contacts SET ${assignments.join(', ')}, updated_at=? WHERE id=?`)
        .run(...values, Date.now(), contactId)
      if (patch.tags !== undefined) this.#replaceTags(contactId, patch.tags)
    })
    const contact = this.getContact({ contactId })
    this.#changed({ contactId, chatId: contact.chatId, scope: 'contact' })
    return contact
  }

  setStage(contactId: string, stageId: string): CrmContactDetailsDto {
    const contact = this.getContact({ contactId })
    const stage = this.#database.db.prepare('SELECT * FROM crm_pipeline_stages WHERE id=?').get(stageId) as Row | undefined
    if (!stage) throw new Error('Pipeline stage not found')
    if (contact.stageId === stageId) return contact
    this.#database.transaction(() => {
      this.#database.db.prepare(`UPDATE crm_contacts SET stage_id=?, lifecycle=CASE WHEN ?='won' THEN 'customer' ELSE lifecycle END,
        last_activity_at=?, updated_at=? WHERE id=?`).run(stageId, String(stage.key), Date.now(), Date.now(), contactId)
      this.#addActivity(contactId, 'stage-changed', `Stage changed from ${contact.stageName} to ${String(stage.name)}`, {
        from: contact.stageId, to: stageId
      })
    })
    this.#changed({ contactId, chatId: contact.chatId, scope: 'pipeline' })
    return this.getContact({ contactId })
  }

  setLifecycle(contactId: string, lifecycle: CrmLifecycle): CrmContactDetailsDto {
    const contact = this.getContact({ contactId })
    if (contact.lifecycle === lifecycle) return contact
    this.#database.transaction(() => {
      this.#database.db.prepare(`UPDATE crm_contacts SET lifecycle=?,
        stage_id=CASE WHEN ?='customer' THEN 'stage-won' WHEN ? IN ('ignored','spam') THEN 'stage-lost' ELSE stage_id END,
        last_activity_at=?, updated_at=? WHERE id=?`).run(lifecycle, lifecycle, lifecycle, Date.now(), Date.now(), contactId)
      this.#addActivity(contactId, 'lifecycle-changed', `Contact marked as ${lifecycle}`, { from: contact.lifecycle, to: lifecycle })
    })
    this.#changed({ contactId, chatId: contact.chatId, scope: 'pipeline' })
    return this.getContact({ contactId })
  }

  listNotes(contactId: string): CrmNoteDto[] {
    this.getContact({ contactId })
    return (this.#database.db.prepare('SELECT * FROM crm_notes WHERE contact_id=? ORDER BY created_at DESC, id').all(contactId) as Row[])
      .map(mapNote)
  }

  addNote(contactId: string, bodyInput: string, sourceMessageId?: string): CrmNoteDto {
    return this.saveNote({ contactId, body: bodyInput, sourceMessageId })
  }

  saveNote(input: CrmNoteInput): CrmNoteDto {
    const contact = this.getContact({ contactId: input.contactId })
    const body = cleanText(input.body, 20_000)
    if (!body) throw new Error('Note cannot be empty')
    const existing = input.id
      ? this.#database.db.prepare('SELECT * FROM crm_notes WHERE id=?').get(input.id) as Row | undefined
      : undefined
    if (input.id && !existing) throw new Error('Note not found')
    if (existing && String(existing.contact_id) !== input.contactId) throw new Error('Note contact cannot be changed')
    const id = input.id ?? randomUUID()
    const now = Date.now()
    const sourceMessage = textValue(existing?.source_message_snapshot)
      ? parseMessageReference(existing?.source_message_snapshot)
      : this.#messageReference(contact, input.sourceMessageId)
    const sourceMessageId = textValue(existing?.source_message_id) ?? sourceMessage?.messageId
    const sourceSnapshot = textValue(existing?.source_message_snapshot) ?? (sourceMessage ? JSON.stringify(sourceMessage) : null)
    this.#database.transaction(() => {
      this.#database.db.prepare(`INSERT INTO crm_notes(
        id, contact_id, body, source_message_id, source_message_snapshot, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at`)
        .run(id, input.contactId, body, sourceMessageId ?? null, sourceSnapshot, numberValue(existing?.created_at) || now, now)
      this.#database.db.prepare('UPDATE crm_contacts SET last_activity_at=?, updated_at=? WHERE id=?').run(now, now, input.contactId)
      this.#addActivity(input.contactId, existing ? 'note-updated' : 'note-added', existing ? 'Note updated' : 'Note added')
    })
    this.#changed({ contactId: input.contactId, chatId: contact.chatId, scope: 'contact' })
    return mapNote(this.#database.db.prepare('SELECT * FROM crm_notes WHERE id=?').get(id) as Row)
  }

  deleteNote(noteId: string): void {
    const note = this.#database.db.prepare(`SELECT notes.contact_id, contacts.chat_id FROM crm_notes notes
      JOIN crm_contacts contacts ON contacts.id=notes.contact_id WHERE notes.id=?`).get(noteId) as Row | undefined
    if (!note) return
    this.#database.db.prepare('DELETE FROM crm_notes WHERE id=?').run(noteId)
    this.#changed({ contactId: String(note.contact_id), chatId: String(note.chat_id), scope: 'contact' })
  }

  listTasks(input: { contactId?: string; status?: CrmTaskDto['status']; due?: 'overdue' | 'today' | 'upcoming' } = {}): CrmTaskDto[] {
    const conditions: string[] = []
    const values: SqlValue[] = []
    if (input.contactId) { conditions.push('contact_id=?'); values.push(input.contactId) }
    if (input.status) { conditions.push('status=?'); values.push(input.status) }
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
    if (input.due === 'overdue') { conditions.push("status='open' AND due_at<?"); values.push(Date.now()) }
    if (input.due === 'today') { conditions.push('due_at>=? AND due_at<?'); values.push(todayStart, tomorrow) }
    if (input.due === 'upcoming') { conditions.push('due_at>=?'); values.push(tomorrow) }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
    return (this.#database.db.prepare(`SELECT * FROM crm_tasks${where}
      ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, due_at IS NULL, due_at, created_at DESC`).all(...values) as Row[]).map(mapTask)
  }

  saveTask(input: CrmTaskInput): CrmTaskDto {
    const contact = this.getContact({ contactId: input.contactId })
    const title = cleanText(input.title, 240)
    if (!title) throw new Error('Task title cannot be empty')
    const existing = input.id
      ? this.#database.db.prepare('SELECT * FROM crm_tasks WHERE id=?').get(input.id) as Row | undefined
      : undefined
    if (input.id && !existing) throw new Error('Task not found')
    if (existing && String(existing.contact_id) !== input.contactId) throw new Error('Task contact cannot be changed')
    const id = input.id ?? randomUUID()
    const now = Date.now()
    const status = input.status ?? (existing?.status as CrmTaskDto['status'] | undefined) ?? 'open'
    const completedAt = status === 'completed' ? numberValue(existing?.completed_at) || now : null
    const sourceMessage = textValue(existing?.source_message_snapshot)
      ? parseMessageReference(existing?.source_message_snapshot)
      : this.#messageReference(contact, input.sourceMessageId)
    const sourceMessageId = textValue(existing?.source_message_id) ?? sourceMessage?.messageId
    const sourceSnapshot = textValue(existing?.source_message_snapshot) ?? (sourceMessage ? JSON.stringify(sourceMessage) : null)
    this.#database.transaction(() => {
      this.#database.db.prepare(`
        INSERT INTO crm_tasks(id, contact_id, order_id, title, description, due_at, priority, status, reminder_at,
          notified_at, source_message_id, source_message_snapshot, created_at, completed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET contact_id=excluded.contact_id, order_id=excluded.order_id, title=excluded.title,
          description=excluded.description, due_at=excluded.due_at, priority=excluded.priority, status=excluded.status,
          reminder_at=excluded.reminder_at,
          notified_at=CASE WHEN excluded.reminder_at IS NOT crm_tasks.reminder_at THEN NULL ELSE crm_tasks.notified_at END,
          completed_at=excluded.completed_at, updated_at=excluded.updated_at
      `).run(id, input.contactId, input.orderId ?? textValue(existing?.order_id) ?? null, title,
        cleanText(input.description ?? textValue(existing?.description), 4_000) || null,
        finiteOptional(input.dueAt ?? numberOptional(existing?.due_at)) ?? null,
        input.priority ?? (existing?.priority as CrmTaskDto['priority'] | undefined) ?? 'normal', status,
        finiteOptional(input.reminderAt ?? numberOptional(existing?.reminder_at)) ?? null,
        numberOptional(existing?.notified_at) ?? null, sourceMessageId ?? null, sourceSnapshot,
        numberValue(existing?.created_at) || now, completedAt, now)
      this.#addActivity(input.contactId, !existing ? 'task-created' : status === 'completed' && existing.status !== 'completed'
        ? 'task-completed' : 'task-updated', !existing ? `Task created: ${title}` : status === 'completed' && existing.status !== 'completed'
          ? `Task completed: ${title}` : `Task updated: ${title}`)
    })
    this.#changed({ contactId: input.contactId, chatId: contact.chatId, scope: 'task' })
    return mapTask(this.#database.db.prepare('SELECT * FROM crm_tasks WHERE id=?').get(id) as Row)
  }

  deleteTask(taskId: string): void {
    const row = this.#database.db.prepare(`SELECT tasks.contact_id, contacts.chat_id FROM crm_tasks tasks
      JOIN crm_contacts contacts ON contacts.id=tasks.contact_id WHERE tasks.id=?`).get(taskId) as Row | undefined
    if (!row) return
    this.#database.db.prepare('DELETE FROM crm_tasks WHERE id=?').run(taskId)
    this.#changed({ contactId: String(row.contact_id), chatId: String(row.chat_id), scope: 'task' })
  }

  takeDueTaskNotifications(now = Date.now()): CrmTaskDto[] {
    const rows = this.#database.db.prepare(`SELECT * FROM crm_tasks WHERE status='open' AND notified_at IS NULL
      AND COALESCE(reminder_at, due_at) IS NOT NULL AND COALESCE(reminder_at, due_at)<=?
      ORDER BY COALESCE(reminder_at, due_at), id LIMIT 25`).all(now) as Row[]
    if (!rows.length) return []
    this.#database.transaction(() => {
      const statement = this.#database.db.prepare('UPDATE crm_tasks SET notified_at=?, updated_at=? WHERE id=? AND notified_at IS NULL')
      for (const row of rows) statement.run(now, now, String(row.id))
    })
    return rows.map((row) => mapTask({ ...row, notified_at: now, updated_at: now }))
  }

  listCatalog(queryInput?: string, includeInactive = false): CrmCatalogItemDto[] {
    const conditions = includeInactive ? [] : ['active=1']
    const values: SqlValue[] = []
    const query = queryInput?.trim()
    if (query) {
      const like = `%${escapeLike(query)}%`
      conditions.push("(name LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')")
      values.push(like, like, like)
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
    return (this.#database.db.prepare(`SELECT * FROM crm_catalog_items${where} ORDER BY active DESC, name COLLATE NOCASE, id`)
      .all(...values) as Row[]).map(mapCatalogItem)
  }

  saveCatalog(input: Partial<CrmCatalogItemDto> & Pick<CrmCatalogItemDto, 'type' | 'name' | 'unitPrice'>): CrmCatalogItemDto {
    const name = cleanText(input.name, 240)
    if (!name) throw new Error('Catalog item name cannot be empty')
    const unitPrice = nonNegative(input.unitPrice, 'unit price')
    const existing = input.id ? this.#database.db.prepare('SELECT * FROM crm_catalog_items WHERE id=?').get(input.id) as Row | undefined : undefined
    if (input.id && !existing) throw new Error('Catalog item not found')
    const id = input.id ?? randomUUID()
    const now = Date.now()
    this.#database.db.prepare(`
      INSERT INTO crm_catalog_items(id, type, name, sku, description, unit_price, currency, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET type=excluded.type, name=excluded.name, sku=excluded.sku,
        description=excluded.description, unit_price=excluded.unit_price, currency=excluded.currency,
        active=excluded.active, updated_at=excluded.updated_at
    `).run(id, input.type, name, cleanText(input.sku, 80) || null, cleanText(input.description, 4_000) || null,
      unitPrice, cleanCurrency(input.currency ?? textValue(existing?.currency)), input.active === undefined
        ? Number(existing ? Boolean(existing.active) : true) : Number(input.active), numberValue(existing?.created_at) || now, now)
    this.#changed({ scope: 'catalog' })
    return mapCatalogItem(this.#database.db.prepare('SELECT * FROM crm_catalog_items WHERE id=?').get(id) as Row)
  }

  deleteCatalog(itemId: string): void {
    const changed = this.#database.db.prepare('UPDATE crm_catalog_items SET active=0, updated_at=? WHERE id=?').run(Date.now(), itemId)
    if (changed.changes) this.#changed({ scope: 'catalog' })
  }

  listOrders(contactId?: string): CrmOrderDto[] {
    const rows = contactId
      ? this.#database.db.prepare('SELECT * FROM crm_orders WHERE contact_id=? ORDER BY created_at DESC, id DESC').all(contactId) as Row[]
      : this.#database.db.prepare('SELECT * FROM crm_orders ORDER BY created_at DESC, id DESC LIMIT 500').all() as Row[]
    return this.#mapOrders(rows)
  }

  getOrder(orderId: string): CrmOrderDto {
    const order = this.#database.db.prepare('SELECT * FROM crm_orders WHERE id=?').get(orderId) as Row | undefined
    if (!order) throw new Error('Order not found')
    return this.#mapOrders([order])[0]!
  }

  #mapOrders(orders: Row[]): CrmOrderDto[] {
    if (!orders.length) return []
    const itemsByOrder = new Map<string, CrmOrderItemDto[]>()
    const paymentsByOrder = new Map<string, CrmPaymentDto[]>()
    for (const batch of chunks(orders.map((order) => String(order.id)), 500)) {
      const placeholders = batch.map(() => '?').join(', ')
      const items = this.#database.db.prepare(
        `SELECT * FROM crm_order_items WHERE order_id IN (${placeholders}) ORDER BY order_id, position, id`
      ).all(...batch) as Row[]
      for (const row of items) {
        const orderId = String(row.order_id)
        const current = itemsByOrder.get(orderId) ?? []
        current.push(mapOrderItem(row))
        itemsByOrder.set(orderId, current)
      }
      const payments = this.#database.db.prepare(
        `SELECT * FROM crm_payments WHERE order_id IN (${placeholders}) ORDER BY order_id, paid_at, id`
      ).all(...batch) as Row[]
      for (const row of payments) {
        const orderId = String(row.order_id)
        const current = paymentsByOrder.get(orderId) ?? []
        current.push(mapPayment(row))
        paymentsByOrder.set(orderId, current)
      }
    }
    return orders.map((order) => {
      const id = String(order.id)
      const items = itemsByOrder.get(id) ?? []
      const payments = paymentsByOrder.get(id) ?? []
      const paidAmount = roundMoney(payments.reduce((total, payment) => total + payment.amount, 0))
      const total = numberValue(order.total)
      return {
        id, contactId: String(order.contact_id), orderNumber: String(order.order_number),
        status: order.status as CrmOrderDto['status'], paymentStatus: order.payment_status as CrmOrderDto['paymentStatus'],
        currency: String(order.currency), subtotal: numberValue(order.subtotal), discount: numberValue(order.discount),
        tax: numberValue(order.tax), total, paidAmount, balanceAmount: roundMoney(Math.max(0, total - paidAmount)),
        shippingAddress: textValue(order.shipping_address), appointmentAt: numberOptional(order.appointment_at),
        expectedAt: numberOptional(order.expected_at), customerNote: textValue(order.customer_note),
        internalNote: textValue(order.internal_note), items, payments,
        createdAt: numberValue(order.created_at), updatedAt: numberValue(order.updated_at), completedAt: numberOptional(order.completed_at)
      }
    })
  }

  saveOrder(input: CrmOrderInput): CrmOrderDto {
    const contact = this.getContact({ contactId: input.contactId })
    if (!input.items.length) throw new Error('An order needs at least one item')
    const existing = input.id ? this.#database.db.prepare('SELECT * FROM crm_orders WHERE id=?').get(input.id) as Row | undefined : undefined
    if (input.id && !existing) throw new Error('Order not found')
    if (existing && String(existing.contact_id) !== input.contactId) throw new Error('An existing order cannot be moved to another contact')
    const id = input.id ?? randomUUID()
    const currency = cleanCurrency(input.currency ?? textValue(existing?.currency))
    const lines = input.items.map((item, index) => calculateLine(item, index))
    const subtotal = roundMoney(lines.reduce((total, line) => total + line.subtotal, 0))
    const discount = roundMoney(lines.reduce((total, line) => total + line.discount, 0))
    const tax = roundMoney(lines.reduce((total, line) => total + line.tax, 0))
    const total = roundMoney(lines.reduce((sum, line) => sum + line.lineTotal, 0))
    const now = Date.now()
    const status = input.status
    const completedAt = status === 'completed' ? numberValue(existing?.completed_at) || now : null
    const orderNumber = textValue(existing?.order_number) ?? this.#nextOrderNumber()
    this.#database.transaction(() => {
      this.#database.db.prepare(`
        INSERT INTO crm_orders(id, contact_id, order_number, status, payment_status, currency, subtotal, discount, tax, total,
          shipping_address, appointment_at, expected_at, customer_note, internal_note, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, ?, 'unpaid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, currency=excluded.currency, subtotal=excluded.subtotal,
          discount=excluded.discount, tax=excluded.tax, total=excluded.total, shipping_address=excluded.shipping_address,
          appointment_at=excluded.appointment_at, expected_at=excluded.expected_at, customer_note=excluded.customer_note,
          internal_note=excluded.internal_note, updated_at=excluded.updated_at, completed_at=excluded.completed_at
      `).run(id, input.contactId, orderNumber, status, currency, subtotal, discount, tax, total,
        cleanText(input.shippingAddress, 1_000) || null, finiteOptional(input.appointmentAt) ?? null,
        finiteOptional(input.expectedAt) ?? null, cleanText(input.customerNote, 4_000) || null,
        cleanText(input.internalNote, 4_000) || null, numberValue(existing?.created_at) || now, now, completedAt)
      this.#database.db.prepare('DELETE FROM crm_order_items WHERE order_id=?').run(id)
      const insertLine = this.#database.db.prepare(`INSERT INTO crm_order_items(
        id, order_id, catalog_item_id, type, name, sku, quantity, unit_price, discount, tax_rate, line_total, position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const line of lines) insertLine.run(randomUUID(), id, line.catalogItemId ?? null, line.type, line.name,
        line.sku ?? null, line.quantity, line.unitPrice, line.discount, line.taxRate, line.lineTotal, line.position)
      if (input.payments !== undefined) {
        this.#database.db.prepare('DELETE FROM crm_payments WHERE order_id=?').run(id)
        const insertPayment = this.#database.db.prepare(`INSERT INTO crm_payments(
          id, order_id, amount, method, reference, paid_at, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        for (const payment of input.payments) insertPayment.run(randomUUID(), id, nonNegative(payment.amount, 'payment amount'),
          cleanText(payment.method, 80) || null, cleanText(payment.reference, 160) || null,
          finiteOptional(payment.paidAt) ?? now, cleanText(payment.note, 1_000) || null)
      }
      const paidRow = this.#database.db.prepare('SELECT COALESCE(SUM(amount), 0) AS paid FROM crm_payments WHERE order_id=?').get(id) as Row
      const paid = roundMoney(numberValue(paidRow.paid))
      if (paid > total + 0.005) throw new Error('Payment cannot exceed the order total')
      const paymentStatus = paid <= 0 ? 'unpaid' : paid + 0.005 >= total ? 'paid' : 'partial'
      this.#database.db.prepare('UPDATE crm_orders SET payment_status=? WHERE id=?').run(paymentStatus, id)
      if (status === 'confirmed' || status === 'in-progress' || status === 'completed') {
        this.#database.db.prepare("UPDATE crm_contacts SET lifecycle='customer', stage_id='stage-won', last_activity_at=?, updated_at=? WHERE id=?")
          .run(now, now, input.contactId)
      } else this.#database.db.prepare('UPDATE crm_contacts SET last_activity_at=?, updated_at=? WHERE id=?').run(now, now, input.contactId)
      this.#addActivity(input.contactId, existing ? 'order-updated' : 'order-created',
        `${existing ? 'Order updated' : 'Order created'}: ${orderNumber}`, { orderId: id, total, currency, status })
    })
    this.#changed({ contactId: input.contactId, chatId: contact.chatId, scope: 'order' })
    return this.getOrder(id)
  }

  deleteOrder(orderId: string): void {
    const row = this.#database.db.prepare('SELECT contact_id FROM crm_orders WHERE id=?').get(orderId) as Row | undefined
    if (!row) return
    this.#database.db.prepare('DELETE FROM crm_orders WHERE id=?').run(orderId)
    this.#changed({ contactId: String(row.contact_id), scope: 'order' })
  }

  activity(contactId: string, limitInput = 100): CrmActivityDto[] {
    this.getContact({ contactId })
    const limit = Math.max(1, Math.min(500, Math.floor(limitInput)))
    return (this.#database.db.prepare('SELECT * FROM crm_activity WHERE contact_id=? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(contactId, limit) as Row[]).map(mapActivity)
  }

  #messageReference(contact: CrmContactDetailsDto, sourceMessageId?: string): CrmMessageReferenceDto | undefined {
    const messageId = cleanText(sourceMessageId, 300)
    if (!messageId) return undefined
    const message = this.#database.getMessage(messageId)
    if (this.#database.resolveChatId(message.chatId) !== this.#database.resolveChatId(contact.chatId)) {
      throw new Error('The source message does not belong to this CRM contact')
    }
    const preview = message.text ?? message.rich?.body ?? message.rich?.title ?? message.attachment?.fileName ?? message.kind
    return {
      messageId: message.id,
      chatId: message.chatId,
      senderId: cleanText(message.senderId, 300) || undefined,
      senderName: cleanText(message.senderName, 160) || undefined,
      fromMe: message.fromMe,
      kind: message.kind,
      text: cleanText(preview, 500) || undefined,
      timestamp: message.timestamp
    }
  }

  #findByChat(chatId: string): Row | undefined {
    return this.#database.db.prepare(`${CONTACT_SELECT} WHERE crm.chat_id=? OR crm.identity_id=(
      SELECT identity_id FROM contact_identity_aliases WHERE alias_id=?
    ) ORDER BY crm.updated_at DESC LIMIT 1`).get(chatId, chatId) as Row | undefined
  }

  #findByIdentity(identityId: string): Row | undefined {
    return this.#database.db.prepare(`${CONTACT_SELECT} WHERE crm.identity_id=? LIMIT 1`).get(identityId) as Row | undefined
  }

  #mapContacts(rows: Row[]): CrmContactSummaryDto[] {
    if (!rows.length) return []
    const ids = rows.map((row) => String(row.id))
    const placeholders = ids.map(() => '?').join(', ')
    const tagRows = this.#database.db.prepare(`SELECT link.contact_id, tags.* FROM crm_contact_tags link
      JOIN crm_tags tags ON tags.id=link.tag_id WHERE link.contact_id IN (${placeholders}) ORDER BY tags.name COLLATE NOCASE`)
      .all(...ids) as Row[]
    const tags = new Map<string, CrmTagDto[]>()
    for (const row of tagRows) {
      const contactId = String(row.contact_id)
      const current = tags.get(contactId) ?? []
      current.push(mapTag(row))
      tags.set(contactId, current)
    }
    return rows.map((row) => mapContactSummary(row, tags.get(String(row.id)) ?? []))
  }

  #mapContactDetails(row: Row): CrmContactDetailsDto {
    const summary = this.#mapContacts([row])[0]!
    return { ...summary, email: textValue(row.email), address: textValue(row.address), birthday: textValue(row.birthday),
      taxId: textValue(row.tax_id), preferences: textValue(row.preferences),
      consentStatus: row.consent_status as CrmContactDetailsDto['consentStatus'], doNotContact: Boolean(row.do_not_contact),
      customFields: parseStringRecord(row.custom_fields) }
  }

  #replaceTags(contactId: string, inputs: Array<{ name: string; color?: string }>): void {
    const unique = new Map<string, { name: string; color: string }>()
    for (const input of inputs.slice(0, 30)) {
      const name = cleanText(input.name, 60)
      if (name) unique.set(name.toLocaleLowerCase(), { name, color: cleanColor(input.color) })
    }
    this.#database.db.prepare('DELETE FROM crm_contact_tags WHERE contact_id=?').run(contactId)
    const upsert = this.#database.db.prepare(`INSERT INTO crm_tags(id, name, color, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET color=excluded.color RETURNING id`)
    const link = this.#database.db.prepare('INSERT OR IGNORE INTO crm_contact_tags(contact_id, tag_id) VALUES (?, ?)')
    for (const value of unique.values()) {
      const row = upsert.get(randomUUID(), value.name, value.color, Date.now()) as Row
      link.run(contactId, String(row.id))
    }
  }

  #addActivity(contactId: string, type: CrmActivityDto['type'], summary: string, metadata?: Record<string, unknown>): void {
    this.#database.db.prepare('INSERT INTO crm_activity(id, contact_id, type, summary, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), contactId, type, summary, metadata ? JSON.stringify(metadata) : null, Date.now())
  }

  #nextOrderNumber(): string {
    const now = new Date()
    const prefix = `WA-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-`
    const row = this.#database.db.prepare('SELECT COUNT(*) AS count FROM crm_orders WHERE order_number LIKE ?').get(`${prefix}%`) as Row
    let sequence = numberValue(row.count) + 1
    while (this.#database.db.prepare('SELECT 1 FROM crm_orders WHERE order_number=?').get(`${prefix}${String(sequence).padStart(4, '0')}`)) sequence += 1
    return `${prefix}${String(sequence).padStart(4, '0')}`
  }

  #changed(payload: { contactId?: string; chatId?: string; scope: 'contact' | 'pipeline' | 'order' | 'task' | 'catalog' | 'all' }): void {
    this.#emit({ type: 'crm.changed', payload })
  }
}

function mapStage(row: Row): CrmStageDto {
  return { id: String(row.id), key: row.key as CrmStageKey, name: String(row.name), color: String(row.color),
    position: numberValue(row.position), outcome: row.outcome as CrmStageDto['outcome'] }
}

function mapContactSummary(row: Row, tags: CrmTagDto[]): CrmContactSummaryDto {
  const phone = formatPhone(textValue(row.phone_number))
  const whatsappName = textValue(row.whatsapp_name)
  const savedName = textValue(row.saved_name)
  const chatTitle = usableName(textValue(row.chat_title), phone)
  const name = textValue(row.name) ?? savedName ?? whatsappName ?? chatTitle ?? phone ?? 'Unknown contact'
  const avatarToken = textValue(row.avatar_token)
  return {
    id: String(row.id), identityId: String(row.identity_id), chatId: String(row.chat_id),
    lifecycle: row.lifecycle as CrmLifecycle, stageId: String(row.stage_id), stageKey: row.stage_key as CrmStageKey,
    stageName: String(row.stage_name), stageColor: String(row.stage_color), name, whatsappName,
    phoneNumber: phone, avatarUrl: avatarToken ? `warish-media://avatars/${encodeURIComponent(avatarToken)}` : undefined,
    company: textValue(row.company), source: String(row.source), tags, createdAt: numberValue(row.created_at),
    lastActivityAt: numberValue(row.last_activity_at), orderCount: numberValue(row.order_count),
    lifetimeValue: numberValue(row.lifetime_value), openTaskCount: numberValue(row.open_task_count)
  }
}

function mapTag(row: Row): CrmTagDto { return { id: String(row.id), name: String(row.name), color: String(row.color) } }
function mapNote(row: Row): CrmNoteDto {
  return { id: String(row.id), contactId: String(row.contact_id), body: String(row.body),
    sourceMessageId: textValue(row.source_message_id), sourceMessage: parseMessageReference(row.source_message_snapshot),
    createdAt: numberValue(row.created_at), updatedAt: numberValue(row.updated_at) }
}
function mapTask(row: Row): CrmTaskDto {
  return { id: String(row.id), contactId: String(row.contact_id), orderId: textValue(row.order_id), title: String(row.title),
    description: textValue(row.description), dueAt: numberOptional(row.due_at), priority: row.priority as CrmTaskDto['priority'],
    status: row.status as CrmTaskDto['status'], reminderAt: numberOptional(row.reminder_at), notifiedAt: numberOptional(row.notified_at),
    sourceMessageId: textValue(row.source_message_id), sourceMessage: parseMessageReference(row.source_message_snapshot),
    createdAt: numberValue(row.created_at), completedAt: numberOptional(row.completed_at) }
}
function mapCatalogItem(row: Row): CrmCatalogItemDto {
  return { id: String(row.id), type: row.type as CrmCatalogItemDto['type'], name: String(row.name), sku: textValue(row.sku),
    description: textValue(row.description), unitPrice: numberValue(row.unit_price), currency: String(row.currency),
    active: Boolean(row.active), createdAt: numberValue(row.created_at), updatedAt: numberValue(row.updated_at) }
}
function mapOrderItem(row: Row): CrmOrderItemDto {
  return { id: String(row.id), catalogItemId: textValue(row.catalog_item_id), type: row.type as CrmOrderItemDto['type'],
    name: String(row.name), sku: textValue(row.sku), quantity: numberValue(row.quantity), unitPrice: numberValue(row.unit_price),
    discount: numberValue(row.discount), taxRate: numberValue(row.tax_rate), lineTotal: numberValue(row.line_total) }
}
function mapPayment(row: Row): CrmPaymentDto {
  return { id: String(row.id), amount: numberValue(row.amount), method: textValue(row.method), reference: textValue(row.reference),
    paidAt: numberValue(row.paid_at), note: textValue(row.note) }
}
function mapActivity(row: Row): CrmActivityDto {
  return { id: String(row.id), contactId: String(row.contact_id), type: row.type as CrmActivityDto['type'],
    summary: String(row.summary), metadata: parseObject(row.metadata), createdAt: numberValue(row.created_at) }
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

function calculateLine(input: CrmOrderInput['items'][number], position: number): Omit<CrmOrderItemDto, 'id'> & {
  position: number; subtotal: number; tax: number
} {
  const name = cleanText(input.name, 240)
  if (!name) throw new Error('Order item name cannot be empty')
  const quantity = positive(input.quantity, 'quantity')
  const unitPrice = nonNegative(input.unitPrice, 'unit price')
  const subtotal = roundMoney(quantity * unitPrice)
  const discount = Math.min(subtotal, nonNegative(input.discount, 'discount'))
  const taxRate = Math.min(100, nonNegative(input.taxRate, 'tax rate'))
  const tax = roundMoney((subtotal - discount) * taxRate / 100)
  return { catalogItemId: input.catalogItemId, type: input.type, name, sku: cleanText(input.sku, 80) || undefined,
    quantity, unitPrice, discount, taxRate, lineTotal: roundMoney(subtotal - discount + tax), position, subtotal, tax }
}

function cleanText(value: string | undefined, max: number): string { return typeof value === 'string' ? value.trim().slice(0, max) : '' }
function cleanCurrency(value?: string): string {
  const currency = value?.trim().toUpperCase()
  return currency && /^[A-Z]{3}$/.test(currency) ? currency : 'INR'
}
function cleanColor(value?: string): string { return value && /^#[0-9a-f]{6}$/i.test(value) ? value : '#64748b' }
function cleanCustomFields(value?: Record<string, string>): Record<string, string> {
  if (!value) return {}
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value).slice(0, 50)) {
    const cleanKey = cleanText(key, 80)
    if (cleanKey) result[cleanKey] = cleanText(entry, 2_000)
  }
  return result
}
function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
function numberValue(value: unknown): number { const number = Number(value ?? 0); return Number.isFinite(number) ? number : 0 }
function numberOptional(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}
function finiteOptional(value: number | undefined): number | undefined { return Number.isFinite(value) ? value : undefined }
function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}`)
  return roundMoney(value)
}
function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${label}`)
  return Math.round(value * 1_000) / 1_000
}
function roundMoney(value: number): number { return Math.round((value + Number.EPSILON) * 100) / 100 }
function escapeLike(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_') }
function formatPhone(value?: string): string | undefined { return value ? `+${value.replace(/^\+/, '')}` : undefined }
function usableName(value: string | undefined, phone: string | undefined): string | undefined {
  if (!value || value === phone || value === phone?.slice(1) || value === 'WhatsApp contact' || /^\+?\d+$/.test(value)) return undefined
  return value
}
function parseStringRecord(value: unknown): Record<string, string> {
  const parsed = parseObject(value)
  if (!parsed) return {}
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}
function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch { return undefined }
}

function parseMessageReference(value: unknown): CrmMessageReferenceDto | undefined {
  const parsed = parseObject(value)
  if (!parsed || typeof parsed.messageId !== 'string' || typeof parsed.chatId !== 'string' ||
    typeof parsed.fromMe !== 'boolean' || typeof parsed.kind !== 'string' || typeof parsed.timestamp !== 'number') return undefined
  const kinds = new Set(['text', 'image', 'video', 'document', 'audio', 'voice', 'sticker', 'location', 'contact',
    'poll', 'rich', 'system', 'unsupported'])
  if (!kinds.has(parsed.kind)) return undefined
  return {
    messageId: parsed.messageId.slice(0, 300), chatId: parsed.chatId.slice(0, 300),
    senderId: typeof parsed.senderId === 'string' ? parsed.senderId.slice(0, 300) : undefined,
    senderName: typeof parsed.senderName === 'string' ? parsed.senderName.slice(0, 160) : undefined,
    fromMe: parsed.fromMe, kind: parsed.kind as CrmMessageReferenceDto['kind'],
    text: typeof parsed.text === 'string' ? parsed.text.slice(0, 500) : undefined,
    timestamp: parsed.timestamp
  }
}
