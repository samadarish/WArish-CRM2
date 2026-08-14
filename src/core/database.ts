import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import type { Logger } from 'pino'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type AttachmentDto,
  type ChatCategory,
  type ChatCrmStageFilter,
  type ChatSummary,
  type CommunitySummary,
  type ContactDetails,
  type DeliveryState,
  type DraftDto,
  type MessageContextDto,
  type MessageDto,
  type MessageKind,
  type Page,
  type PickedAttachment,
  type QuotedMessageDto,
  type RichMessageDto
} from '../shared/contracts'
import { CryptoBox } from './crypto'

const ACCOUNT_ID = 'primary'
const SQL_MESSAGE_PREVIEW = `CASE
  WHEN m.deleted=1 THEN 'This message was deleted'
  WHEN NULLIF(m.text, '') IS NOT NULL THEN m.text
  WHEN m.kind='image' THEN 'Photo'
  WHEN m.kind='video' THEN 'Video'
  WHEN m.kind='document' THEN 'Document'
  WHEN m.kind='audio' THEN 'Audio'
  WHEN m.kind='voice' THEN 'Voice message'
  WHEN m.kind='sticker' THEN 'Sticker'
  WHEN m.kind='location' THEN 'Location'
  WHEN m.kind='contact' THEN 'Contact'
  WHEN m.kind='poll' THEN 'Poll'
  ELSE 'Message' END`
const CONTROL_PLACEHOLDER_TEXT = [
  'Unsupported message: protocolMessage',
  'Unsupported message: senderKeyDistributionMessage',
  'Unsupported message: fastRatchetKeySenderKeyDistributionMessage',
  'Unsupported message: messageContextInfo'
] as const
const SQL_RESOLVED_CHAT_COLUMNS = `chats.*,
  latest_message.from_me AS last_message_from_me,
  latest_message.status AS last_message_status,
  identity.saved_name AS contact_saved_name,
  identity.whatsapp_name AS contact_whatsapp_name,
  identity.phone_number AS contact_phone_number,
  identity.avatar_token AS contact_avatar_token,
  crm.id AS crm_contact_id,
  crm.name AS crm_name,
  crm.lifecycle AS crm_lifecycle,
  crm.stage_id AS crm_stage_id,
  crm_stage.key AS crm_stage_key,
  crm_stage.name AS crm_stage_name,
  crm_stage.color AS crm_stage_color,
  COALESCE(crm_task_count.open_task_count, 0) AS crm_open_task_count,
  crm_next_task.id AS crm_next_task_id,
  crm_next_task.title AS crm_next_task_title,
  crm_next_task.due_at AS crm_next_task_due_at,
  crm_next_task.priority AS crm_next_task_priority,
  CASE WHEN crm.do_not_contact=1 OR crm.consent_status='denied' THEN 1 ELSE 0 END AS crm_restricted`
const SQL_RESOLVED_CHAT_FROM = `FROM chats
  LEFT JOIN messages latest_message ON latest_message.id=chats.last_message_id
  LEFT JOIN contact_identity_aliases identity_alias ON identity_alias.alias_id=chats.id
  LEFT JOIN contact_identities identity ON identity.identity_id=identity_alias.identity_id
  LEFT JOIN crm_contacts crm ON crm.identity_id=identity.identity_id
  LEFT JOIN crm_pipeline_stages crm_stage ON crm_stage.id=crm.stage_id
  LEFT JOIN (
    SELECT contact_id, COUNT(*) AS open_task_count FROM crm_tasks WHERE status='open' GROUP BY contact_id
  ) crm_task_count ON crm_task_count.contact_id=crm.id
  LEFT JOIN (
    SELECT id, contact_id, title, due_at, priority FROM (
      SELECT id, contact_id, title, due_at, priority,
        ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY due_at IS NULL, due_at, created_at, id) AS task_rank
      FROM crm_tasks WHERE status='open'
    ) WHERE task_rank=1
  ) crm_next_task ON crm_next_task.contact_id=crm.id`

export interface StoredMessage {
  id: string
  chatId: string
  senderId?: string
  senderName?: string
  fromMe: boolean
  kind: MessageKind
  text?: string
  timestamp: number
  status: DeliveryState
  quotedMessageId?: string
  quoted?: QuotedMessageDto
  rich?: RichMessageDto
  edited?: boolean
  deleted?: boolean
  clientId?: string
  error?: string
  rawPayload?: Buffer
  incrementUnread?: boolean
  attachment?: Omit<AttachmentDto, 'messageId'>
}

export interface MessageHistoryAnchor {
  id: string
  timestamp: number
  rawPayload: Buffer
}

export interface ChatMergeResult {
  chatId: string
  mergedChatIds: string[]
}

export interface IdentityRepairResult {
  scanned: number
  mappings: number
  merges: ChatMergeResult[]
}

export class WarishDatabase {
  readonly db: DatabaseSync
  readonly path: string
  readonly #crypto: CryptoBox
  readonly #logger: Logger
  #transactionDepth = 0

  constructor(path: string, masterKey: Buffer, logger: Logger) {
    mkdirSync(dirname(path), { recursive: true })
    this.path = path
    this.#crypto = new CryptoBox(masterKey)
    this.#logger = logger
    this.db = new DatabaseSync(path, { timeout: 5_000, defensive: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;')
    this.#migrate()
  }

  close(): void {
    this.db.close()
  }

  async backupTo(directory: string): Promise<string> {
    mkdirSync(directory, { recursive: true })
    const target = join(directory, `warish-${new Date().toISOString().replaceAll(':', '-')}.sqlite`)
    await backup(this.db, target)
    return target
  }

  sizeBytes(): number {
    return existsSync(this.path) ? statSync(this.path).size : 0
  }

  transaction<T>(operation: () => T): T {
    if (this.#transactionDepth > 0) return operation()
    this.db.exec('BEGIN IMMEDIATE')
    this.#transactionDepth += 1
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.#transactionDepth -= 1
    }
  }

  getAuth(category: string, key: string): Buffer | undefined {
    const row = this.db
      .prepare('SELECT value FROM auth_store WHERE account_id = ? AND category = ? AND key_id = ?')
      .get(ACCOUNT_ID, category, key) as { value: Uint8Array } | undefined
    return row ? this.#crypto.decrypt(row.value, `${category}:${key}`) : undefined
  }

  getAuthMany(category: string, keys: string[]): Map<string, Buffer> {
    if (!keys.length) return new Map()
    const placeholders = keys.map(() => '?').join(', ')
    const rows = this.db.prepare(
      `SELECT key_id, value FROM auth_store WHERE account_id=? AND category=? AND key_id IN (${placeholders})`
    ).all(ACCOUNT_ID, category, ...keys) as Array<{ key_id: string; value: Uint8Array }>
    return new Map(rows.map((row) => [row.key_id, this.#crypto.decrypt(row.value, `${category}:${row.key_id}`)]))
  }

  setAuth(category: string, key: string, value?: Buffer): void {
    if (!value) {
      this.db.prepare('DELETE FROM auth_store WHERE account_id = ? AND category = ? AND key_id = ?').run(ACCOUNT_ID, category, key)
      return
    }
    const encrypted = this.#crypto.encrypt(value, `${category}:${key}`)
    this.db.prepare(
      `INSERT INTO auth_store(account_id, category, key_id, value, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id, category, key_id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    ).run(ACCOUNT_ID, category, key, encrypted, Date.now())
  }

  clearAuth(): void {
    this.db.prepare('DELETE FROM auth_store WHERE account_id = ?').run(ACCOUNT_ID)
  }

  needsIdentityRepair(): boolean {
    const completed = this.db.prepare("SELECT 1 FROM sync_state WHERE key='identity_repair_v6'").get()
    if (completed) return false
    return Boolean(this.db.prepare(
      "SELECT 1 FROM auth_store WHERE account_id=? AND category='lid-mapping' AND substr(key_id, -8) != '_reverse' LIMIT 1"
    ).get(ACCOUNT_ID))
  }

  completeIdentityRepair(): void {
    this.db.prepare(
      "INSERT INTO sync_state(key, value, updated_at) VALUES ('identity_repair_v6', 'complete', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
    ).run(Date.now())
  }

  needsMessageContentRepair(): boolean {
    return !this.db.prepare("SELECT 1 FROM sync_state WHERE key='message_content_repair_v4'").get()
  }

  listMessageIdsForContentRepair(): string[] {
    const rows = this.db.prepare(
      `SELECT id FROM messages WHERE raw_payload IS NOT NULL AND
       (kind='unsupported' OR (quoted_message_id IS NOT NULL AND quoted_kind IS NULL)) ORDER BY id`
    ).all() as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  completeMessageContentRepair(): void {
    this.db.prepare(
      "INSERT INTO sync_state(key, value, updated_at) VALUES ('message_content_repair_v4', 'complete', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
    ).run(Date.now())
  }

  deleteStoredMessage(messageId: string): void {
    const row = this.db.prepare('SELECT chat_id FROM messages WHERE id=?').get(messageId) as { chat_id: string } | undefined
    if (!row) return
    this.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE id=?').run(messageId)
      const remaining = this.db.prepare('SELECT 1 FROM messages WHERE chat_id=? LIMIT 1').get(row.chat_id)
      if (!remaining) {
        this.db.prepare(`DELETE FROM chats WHERE id=? AND kind!='community' AND NOT EXISTS (SELECT 1 FROM drafts WHERE chat_id=?)
          AND NOT EXISTS (SELECT 1 FROM outbox WHERE chat_id=?)`).run(row.chat_id, row.chat_id, row.chat_id)
      } else {
        this.#repairChatPreview(row.chat_id)
      }
    })
  }

  recoverContactLidMappings(limit?: number, offset = 0, wantedLids?: readonly string[]): IdentityRepairResult {
    const rows = (limit
      ? this.db.prepare(
        `SELECT key_id FROM auth_store WHERE account_id=? AND category='lid-mapping' AND substr(key_id, -8) != '_reverse'
         ORDER BY key_id LIMIT ? OFFSET ?`
      ).all(ACCOUNT_ID, Math.max(1, Math.floor(limit)), Math.max(0, Math.floor(offset)))
      : this.db.prepare(
        `SELECT key_id FROM auth_store WHERE account_id=? AND category='lid-mapping' AND substr(key_id, -8) != '_reverse'
         ORDER BY key_id`
      ).all(ACCOUNT_ID)) as Array<{ key_id: string }>
    const mappings: Array<{ lid: string; phoneJid: string }> = []
    const merges: ChatMergeResult[] = []
    const wanted = wantedLids ? new Set(wantedLids.map((lid) => normalizeDirectJid(lid, 'lid'))) : undefined
    for (const { key_id: phoneUser } of rows) {
      try {
        const stored = this.getAuth('lid-mapping', phoneUser)
        const lidUser = stored ? JSON.parse(stored.toString('utf8')) as unknown : undefined
        if (typeof lidUser === 'string' && lidUser.trim()) {
          const lid = normalizeDirectJid(`${lidUser}@lid`, 'lid')
          if (!wanted || wanted.has(lid)) mappings.push({ lid, phoneJid: `${phoneUser}@s.whatsapp.net` })
        }
      } catch (error) {
        this.#logger.warn({ error, phoneUser }, 'stored contact mapping could not be decoded')
      }
    }
    this.transaction(() => {
      for (const mapping of mappings) {
        const merge = this.linkContactLid(mapping.lid, mapping.phoneJid)
        if (merge?.mergedChatIds.length) merges.push(merge)
      }
    })
    return { scanned: rows.length, mappings: mappings.length, merges }
  }

  resetUserData(): void {
    this.transaction(() => {
      this.db.exec(`
        DELETE FROM crm_activity;
        DELETE FROM crm_payments;
        DELETE FROM crm_order_items;
        DELETE FROM crm_orders;
        DELETE FROM crm_tasks;
        DELETE FROM crm_notes;
        DELETE FROM crm_contact_tags;
        DELETE FROM crm_tags;
        DELETE FROM crm_contacts;
        DELETE FROM crm_catalog_items;
        DELETE FROM reactions;
        DELETE FROM receipts;
        DELETE FROM attachments;
        DELETE FROM messages;
        DELETE FROM chat_aliases;
        DELETE FROM chats;
        DELETE FROM contact_identity_aliases;
        DELETE FROM contact_identities;
        DELETE FROM contacts;
        DELETE FROM drafts;
        DELETE FROM outbox;
        DELETE FROM sync_state;
        DELETE FROM auth_store;
        UPDATE accounts SET phone_number=NULL, display_name=NULL, linked_at=NULL WHERE id='primary';
      `)
    })
  }

  setAccount(phoneNumber?: string, displayName?: string): void {
    this.db.prepare(
      `INSERT INTO accounts(id, phone_number, display_name, created_at, linked_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET phone_number=excluded.phone_number, display_name=excluded.display_name, linked_at=excluded.linked_at`
    ).run(ACCOUNT_ID, phoneNumber ?? null, displayName ?? null, Date.now(), Date.now())
  }

  hasLinkedAccount(): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM accounts WHERE id=? AND linked_at IS NOT NULL').get(ACCOUNT_ID))
  }

  upsertContact(input: { id: string; lid?: string; phoneNumber?: string; name?: string; pushName?: string; avatarUrl?: string }): void {
    this.db.prepare(
      `INSERT INTO contacts(id, account_id, jid, lid, phone_number, name, push_name, avatar_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET lid=COALESCE(excluded.lid, contacts.lid),
       phone_number=COALESCE(excluded.phone_number, contacts.phone_number), name=COALESCE(excluded.name, contacts.name),
       push_name=COALESCE(excluded.push_name, contacts.push_name), avatar_url=COALESCE(excluded.avatar_url, contacts.avatar_url),
       updated_at=excluded.updated_at`
    ).run(input.id, ACCOUNT_ID, input.id, input.lid ?? null, input.phoneNumber ?? null, input.name ?? null,
      input.pushName ?? null, input.avatarUrl ?? null, Date.now())
    this.#upsertCanonicalContact(input)
  }

  linkContactLid(lid: string, phoneJid: string): ChatMergeResult | undefined {
    if (!lid || !phoneJid) return undefined
    const lidJid = normalizeDirectJid(lid, 'lid')
    const normalizedPhoneJid = normalizeDirectJid(phoneJid, 's.whatsapp.net')
    const phoneNumber = normalizedPhoneJid.split('@')[0] ?? normalizedPhoneJid
    return this.transaction(() => {
      const existing = this.db.prepare(
        `SELECT name, push_name, avatar_url FROM contacts
         WHERE id IN (?, ?) OR lid=? OR phone_number=?
         ORDER BY CASE WHEN NULLIF(TRIM(name), '') IS NOT NULL THEN 0 ELSE 1 END,
           CASE WHEN NULLIF(TRIM(push_name), '') IS NOT NULL THEN 0 ELSE 1 END LIMIT 1`
      ).get(normalizedPhoneJid, lidJid, lidJid, phoneNumber) as { name?: string; push_name?: string; avatar_url?: string } | undefined
      this.upsertContact({ id: normalizedPhoneJid, lid: lidJid, phoneNumber, name: existing?.name,
        pushName: existing?.push_name, avatarUrl: existing?.avatar_url })
      this.db.prepare(
        `UPDATE contacts SET lid=?, phone_number=?, updated_at=?
         WHERE id IN (?, ?) OR lid=? OR phone_number=?`
      ).run(lidJid, phoneNumber, Date.now(), normalizedPhoneJid, lidJid, lidJid, phoneNumber)
      const merge = this.#mergeDirectChats(lidJid, [normalizedPhoneJid, phoneJid, lid])
      for (const alias of new Set([normalizedPhoneJid, phoneJid, lid, ...merge.mergedChatIds])) {
        if (alias && alias !== lidJid) this.#upsertChatAlias(alias, lidJid)
      }
      return merge.mergedChatIds.length ? merge : undefined
    })
  }

  resolveChatId(chatId: string): string {
    let current = chatId
    const visited = new Set<string>()
    while (!visited.has(current)) {
      visited.add(current)
      const row = this.db.prepare('SELECT canonical_id FROM chat_aliases WHERE alias_id=?').get(current) as { canonical_id: string } | undefined
      if (!row || row.canonical_id === current) break
      current = row.canonical_id
    }
    return current
  }

  ensureCanonicalContact(chatId: string): string {
    const resolved = this.resolveChatId(chatId)
    return this.#upsertCanonicalContact({ id: resolved })
  }

  upsertChat(input: Omit<Partial<ChatSummary>, 'id' | 'title' | 'kind' | 'communityId'> & Pick<ChatSummary, 'id' | 'title' | 'kind'> & {
    incrementUnread?: boolean
    preserveTitle?: boolean
    lastMessageId?: string
    communityId?: string | null
    classificationKnown?: boolean
  }): void {
    const chatId = this.resolveChatId(input.id)
    const hasLatestMessage = Boolean(input.lastMessageId)
    const classificationKnown = input.classificationKnown ?? true
    this.db.prepare(
      `INSERT INTO chats(id, account_id, title, kind, community_id, is_community_announcement, description, avatar_url, last_message, last_message_at, last_message_id,
       unread_count, archived, pinned, muted_until, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title=CASE WHEN ?=1 THEN chats.title WHEN excluded.title != '' THEN excluded.title ELSE chats.title END,
       kind=CASE WHEN ?=1 THEN excluded.kind ELSE chats.kind END,
       community_id=CASE WHEN ?=1 THEN excluded.community_id ELSE chats.community_id END,
       is_community_announcement=CASE WHEN ?=1 THEN excluded.is_community_announcement ELSE chats.is_community_announcement END,
       description=COALESCE(excluded.description, chats.description),
       avatar_url=COALESCE(excluded.avatar_url, chats.avatar_url),
       last_message=CASE WHEN excluded.last_message_id IS NOT NULL AND
         (chats.last_message_id IS NULL OR excluded.last_message_id = chats.last_message_id OR excluded.last_message_at > COALESCE(chats.last_message_at, 0) OR
          (excluded.last_message_at = chats.last_message_at AND excluded.last_message_id > chats.last_message_id))
         THEN excluded.last_message ELSE chats.last_message END,
       last_message_at=CASE WHEN excluded.last_message_id IS NOT NULL AND
         (chats.last_message_id IS NULL OR excluded.last_message_id = chats.last_message_id OR excluded.last_message_at > COALESCE(chats.last_message_at, 0) OR
          (excluded.last_message_at = chats.last_message_at AND excluded.last_message_id > chats.last_message_id))
         THEN excluded.last_message_at ELSE chats.last_message_at END,
       last_message_id=CASE WHEN excluded.last_message_id IS NOT NULL AND
         (chats.last_message_id IS NULL OR excluded.last_message_id = chats.last_message_id OR excluded.last_message_at > COALESCE(chats.last_message_at, 0) OR
          (excluded.last_message_at = chats.last_message_at AND excluded.last_message_id > chats.last_message_id))
         THEN excluded.last_message_id ELSE chats.last_message_id END,
       unread_count=CASE WHEN ?=1 THEN chats.unread_count + excluded.unread_count
         WHEN excluded.unread_count > chats.unread_count THEN excluded.unread_count ELSE chats.unread_count END,
       archived=CASE WHEN ?=1 THEN excluded.archived ELSE chats.archived END,
       pinned=CASE WHEN ?=1 THEN excluded.pinned ELSE chats.pinned END,
       muted_until=COALESCE(excluded.muted_until, chats.muted_until), updated_at=excluded.updated_at`
    ).run(chatId, ACCOUNT_ID, input.title, input.kind, input.communityId ?? null, Number(input.isAnnouncement ?? false),
      input.description ?? null, input.avatarUrl ?? null,
      hasLatestMessage ? input.lastMessage ?? null : null, hasLatestMessage ? input.lastMessageAt ?? null : null,
      input.lastMessageId ?? null, input.unreadCount ?? 0, input.archived === undefined ? 0 : Number(input.archived),
      input.pinned === undefined ? 0 : Number(input.pinned), input.mutedUntil ?? null, Date.now(),
      Number(input.preserveTitle ?? false), Number(classificationKnown), Number(classificationKnown), Number(classificationKnown),
      Number(input.incrementUnread ?? false),
      Number(input.archived !== undefined), Number(input.pinned !== undefined))
  }

  updateChat(chatId: string, patch: { archived?: boolean; pinned?: boolean; mutedUntil?: number }): void {
    const resolvedChatId = this.resolveChatId(chatId)
    const current = this.getChat(resolvedChatId)
    this.db.prepare('UPDATE chats SET archived=?, pinned=?, muted_until=?, updated_at=? WHERE id=?').run(
      Number(patch.archived ?? current.archived), Number(patch.pinned ?? current.pinned),
      patch.mutedUntil ?? current.mutedUntil ?? null, Date.now(), resolvedChatId)
  }

  markChatRead(chatId: string): void {
    this.db.prepare('UPDATE chats SET unread_count=0, updated_at=? WHERE id=?').run(Date.now(), this.resolveChatId(chatId))
  }

  getChat(chatId: string): ChatSummary {
    chatId = this.resolveChatId(chatId)
    const row = this.db.prepare(`SELECT ${SQL_RESOLVED_CHAT_COLUMNS} ${SQL_RESOLVED_CHAT_FROM} WHERE chats.id=?`)
      .get(chatId) as Record<string, unknown> | undefined
    if (!row) throw new Error(`Chat ${chatId} was not found`)
    return mapChat(row)
  }

  getChats(chatIds: string[]): ChatSummary[] {
    const resolvedIds = [...new Set(chatIds.map((chatId) => this.resolveChatId(chatId)))].slice(0, 100)
    if (!resolvedIds.length) return []
    const placeholders = resolvedIds.map(() => '?').join(', ')
    const rows = this.db.prepare(
      `SELECT ${SQL_RESOLVED_CHAT_COLUMNS} ${SQL_RESOLVED_CHAT_FROM} WHERE chats.id IN (${placeholders})`
    ).all(...resolvedIds) as Record<string, unknown>[]
    const chats = new Map(rows.map((row) => [String(row.id), mapChat(row)]))
    return resolvedIds.flatMap((id) => {
      const chat = chats.get(id)
      return chat ? [chat] : []
    })
  }

  listChats(input: { cursor?: string; limit?: number; archived?: boolean; query?: string; category?: ChatCategory;
    crmStage?: ChatCrmStageFilter }): Page<ChatSummary> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
    const cursor = decodeChatCursor(input.cursor)
    const query = `%${(input.query ?? '').trim()}%`
    const category = input.category ?? 'all'
    const crmStage = input.crmStage ?? 'all'
    const rows = this.db.prepare(
      `SELECT * FROM (SELECT ${SQL_RESOLVED_CHAT_COLUMNS} ${SQL_RESOLVED_CHAT_FROM}) resolved WHERE archived=?
       AND (kind='channel' OR last_message_id IS NOT NULL OR EXISTS (SELECT 1 FROM drafts d WHERE d.chat_id=resolved.id)
         OR EXISTS (SELECT 1 FROM outbox o WHERE o.chat_id=resolved.id AND o.state IN ('queued', 'sending', 'failed')))
       AND (?='all' OR (?='direct' AND kind='direct') OR (?='group' AND kind='group' AND community_id IS NULL)
         OR (?='community' AND (kind='community' OR community_id IS NOT NULL)) OR (?='channel' AND kind='channel'))
       AND (?='all' OR crm_stage_key=?)
       AND (pinned < ? OR (pinned = ? AND
         (COALESCE(last_message_at, 0) < ? OR (COALESCE(last_message_at, 0) = ? AND id < ?))))
       AND (? = '%%' OR title LIKE ? COLLATE NOCASE OR crm_name LIKE ? COLLATE NOCASE OR contact_saved_name LIKE ? COLLATE NOCASE OR
         contact_whatsapp_name LIKE ? COLLATE NOCASE OR
         contact_phone_number LIKE ? COLLATE NOCASE)
       ORDER BY pinned DESC, COALESCE(last_message_at, 0) DESC, id DESC LIMIT ?`
    ).all(Number(input.archived ?? false), category, category, category, category, category, crmStage, crmStage,
      cursor.pinned, cursor.pinned, cursor.timestamp, cursor.timestamp, cursor.id,
      query, query, query, query, query, query, limit + 1) as Record<string, unknown>[]
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(mapChat)
    const last = items.at(-1)
    return { items, nextCursor: hasMore && last ? encodeChatCursor(last) : undefined }
  }

  listCommunities(input: { cursor?: string; limit?: number; query?: string }): Page<CommunitySummary> {
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 50)
    const cursor = decodeCommunityCursor(input.cursor)
    const query = `%${(input.query ?? '').trim()}%`
    const rows = this.db.prepare(
      `WITH community_rows AS (
         SELECT p.id, p.title, p.avatar_url,
           MAX(COALESCE(c.last_message_at, p.last_message_at, 0)) AS activity,
           COALESCE(SUM(CASE WHEN c.archived=0 THEN c.unread_count ELSE 0 END), 0) + p.unread_count AS unread_count
         FROM chats p LEFT JOIN chats c ON c.community_id=p.id
         WHERE p.kind='community'
         GROUP BY p.id
       )
       SELECT * FROM community_rows cr
       WHERE (activity < ? OR (activity = ? AND id < ?))
       AND (?='%%' OR title LIKE ? COLLATE NOCASE OR EXISTS (
         SELECT 1 FROM chats child WHERE child.community_id=cr.id AND child.title LIKE ? COLLATE NOCASE
       ))
       ORDER BY activity DESC, id DESC LIMIT ?`
    ).all(cursor.timestamp, cursor.timestamp, cursor.id, query, query, query, limit + 1) as Record<string, unknown>[]
    const hasMore = rows.length > limit
    const selected = rows.slice(0, limit)
    const parentIds = selected.map((row) => String(row.id))
    const childrenByCommunity = new Map<string, ChatSummary[]>()
    if (parentIds.length) {
      const placeholders = parentIds.map(() => '?').join(', ')
      const childRows = this.db.prepare(
        `SELECT ${SQL_RESOLVED_CHAT_COLUMNS} ${SQL_RESOLVED_CHAT_FROM} WHERE chats.community_id IN (${placeholders}) AND chats.archived=0
         ORDER BY is_community_announcement DESC, pinned DESC, COALESCE(last_message_at, 0) DESC, id DESC`
      ).all(...parentIds) as Record<string, unknown>[]
      for (const childRow of childRows) {
        const communityId = String(childRow.community_id)
        const children = childrenByCommunity.get(communityId) ?? []
        children.push(mapChat(childRow))
        childrenByCommunity.set(communityId, children)
      }
    }
    const items = selected.map((row) => ({
      id: String(row.id), title: validIdentity(nullableString(row.title)) ?? 'Community',
      avatarUrl: nullableString(row.avatar_url), lastMessageAt: nullableNumber(row.activity),
      unreadCount: Number(row.unread_count ?? 0), children: childrenByCommunity.get(String(row.id)) ?? []
    } satisfies CommunitySummary))
    const last = selected.at(-1)
    return { items, nextCursor: hasMore && last
      ? encodeCommunityCursor(Number(last.activity ?? 0), String(last.id))
      : undefined }
  }

  listChannelIds(): string[] {
    const rows = this.db.prepare("SELECT id FROM chats WHERE kind='channel' ORDER BY updated_at DESC").all() as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  getContactDetails(chatId: string): ContactDetails {
    const chat = this.getChat(chatId)
    return {
      chatId: chat.id,
      kind: chat.kind,
      title: chat.title,
      savedName: chat.savedName,
      whatsappName: chat.whatsappName,
      phoneNumber: chat.phoneNumber,
      avatarUrl: chat.avatarUrl,
      communityId: chat.communityId,
      description: chat.description,
      pinned: chat.pinned,
      archived: chat.archived,
      mutedUntil: chat.mutedUntil
    }
  }

  listDirectLidChatIds(chatIds?: string[]): string[] {
    const selected = chatIds?.filter((id) => id.endsWith('@lid') || id.endsWith('@hosted.lid')) ?? []
    if (chatIds && !selected.length) return []
    const filter = selected.length ? `AND chats.id IN (${selected.map(() => '?').join(', ')})` : ''
    const rows = this.db.prepare(
      `SELECT chats.id FROM chats
       LEFT JOIN contact_identity_aliases identity_alias ON identity_alias.alias_id=chats.id
       LEFT JOIN contact_identities identity ON identity.identity_id=identity_alias.identity_id
       WHERE chats.kind='direct' AND (chats.id LIKE '%@lid' OR chats.id LIKE '%@hosted.lid')
         AND identity.phone_jid IS NULL ${filter}
       ORDER BY chats.pinned DESC, COALESCE(chats.last_message_at, 0) DESC, chats.id DESC`
    ).all(...selected) as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  contactLookupJid(chatId: string): string {
    const resolved = this.resolveChatId(chatId)
    const row = this.db.prepare(
      `SELECT identity.phone_jid, identity.lid FROM contact_identity_aliases identity_alias
       JOIN contact_identities identity ON identity.identity_id=identity_alias.identity_id
       WHERE identity_alias.alias_id=?`
    ).get(resolved) as { phone_jid?: string; lid?: string } | undefined
    return row?.phone_jid ?? row?.lid ?? resolved
  }

  contactAddressing(chatId: string): { chatId: string; phoneJid?: string; lidJid?: string } {
    const resolved = this.resolveChatId(chatId)
    const row = this.db.prepare(
      `SELECT identity.phone_jid, identity.lid FROM contact_identity_aliases identity_alias
       JOIN contact_identities identity ON identity.identity_id=identity_alias.identity_id
       WHERE identity_alias.alias_id=?`
    ).get(resolved) as { phone_jid?: string; lid?: string } | undefined
    return {
      chatId: resolved,
      phoneJid: row?.phone_jid ?? (resolved.endsWith('@s.whatsapp.net') ? resolved : undefined),
      lidJid: row?.lid ?? (resolved.endsWith('@lid') || resolved.endsWith('@hosted.lid') ? resolved : undefined)
    }
  }

  shouldRefreshContactAvatar(chatId: string, force = false, now = Date.now()): boolean {
    const resolved = this.resolveChatId(chatId)
    const row = this.db.prepare(
      `SELECT identity.avatar_token, identity.avatar_checked_at, identity.avatar_missing_until
       FROM contact_identity_aliases identity_alias
       JOIN contact_identities identity ON identity.identity_id=identity_alias.identity_id
       WHERE identity_alias.alias_id=?`
    ).get(resolved) as { avatar_token?: string; avatar_checked_at?: number; avatar_missing_until?: number } | undefined
    if (!row) return false
    if (force) return true
    if (Number(row.avatar_missing_until ?? 0) > now) return false
    return !row.avatar_token || Number(row.avatar_checked_at ?? 0) < now - 7 * 24 * 60 * 60 * 1000
  }

  saveContactAvatar(chatId: string, token: string): void {
    const resolved = this.resolveChatId(chatId)
    this.#upsertCanonicalContact({ id: resolved })
    this.db.prepare(
      `UPDATE contact_identities SET avatar_token=?, avatar_checked_at=?, avatar_missing_until=NULL,
       avatar_failures=0, updated_at=?
       WHERE identity_id=(SELECT identity_id FROM contact_identity_aliases WHERE alias_id=?)`
    ).run(token, Date.now(), Date.now(), resolved)
  }

  markContactAvatarMissing(chatId: string): void {
    const resolved = this.resolveChatId(chatId)
    this.#upsertCanonicalContact({ id: resolved })
    const now = Date.now()
    this.db.prepare(
      `UPDATE contact_identities SET avatar_token=NULL, avatar_checked_at=?, avatar_missing_until=?,
       avatar_failures=avatar_failures+1, updated_at=?
       WHERE identity_id=(SELECT identity_id FROM contact_identity_aliases WHERE alias_id=?)`
    ).run(now, now + 24 * 60 * 60 * 1000, now, resolved)
  }

  markContactAvatarFailure(chatId: string, retryAfterMs = 5 * 60 * 1000): void {
    const resolved = this.resolveChatId(chatId)
    this.#upsertCanonicalContact({ id: resolved })
    const now = Date.now()
    this.db.prepare(
      `UPDATE contact_identities SET avatar_missing_until=?,
       avatar_failures=avatar_failures+1, updated_at=?
       WHERE identity_id=(SELECT identity_id FROM contact_identity_aliases WHERE alias_id=?)`
    ).run(now + Math.max(1_000, Math.min(retryAfterMs, 60 * 60 * 1000)), now, resolved)
  }

  clearContactAvatarTokens(): void {
    this.db.prepare(
      'UPDATE contact_identities SET avatar_token=NULL, avatar_checked_at=NULL, avatar_missing_until=NULL, avatar_failures=0, updated_at=?'
    )
      .run(Date.now())
  }

  identityCoverage(): {
    directChats: number
    resolvedNames: number
    resolvedPhones: number
    savedNames: number
    profileNames: number
    cachedAvatars: number
    failedAvatarRequests: number
  } {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS direct_chats,
       SUM(CASE WHEN identity.saved_name IS NOT NULL OR identity.whatsapp_name IS NOT NULL THEN 1 ELSE 0 END) AS resolved_names,
       SUM(CASE WHEN identity.phone_number IS NOT NULL THEN 1 ELSE 0 END) AS resolved_phones,
       SUM(CASE WHEN identity.saved_name IS NOT NULL THEN 1 ELSE 0 END) AS saved_names,
       SUM(CASE WHEN identity.whatsapp_name IS NOT NULL THEN 1 ELSE 0 END) AS profile_names,
       SUM(CASE WHEN identity.avatar_token IS NOT NULL THEN 1 ELSE 0 END) AS cached_avatars
       FROM chats
       LEFT JOIN contact_identity_aliases identity_alias ON identity_alias.alias_id=chats.id
       LEFT JOIN contact_identities identity ON identity.identity_id=identity_alias.identity_id
       WHERE chats.kind='direct'`
    ).get() as Record<string, number | null>
    const failures = this.db.prepare('SELECT COALESCE(SUM(avatar_failures), 0) AS failures FROM contact_identities')
      .get() as { failures: number }
    return {
      directChats: Number(row.direct_chats ?? 0),
      resolvedNames: Number(row.resolved_names ?? 0),
      resolvedPhones: Number(row.resolved_phones ?? 0),
      savedNames: Number(row.saved_names ?? 0),
      profileNames: Number(row.profile_names ?? 0),
      cachedAvatars: Number(row.cached_avatars ?? 0),
      failedAvatarRequests: Number(failures.failures ?? 0)
    }
  }

  upsertMessage(input: StoredMessage): MessageDto {
    this.storeMessage(input)
    return this.getMessage(input.id)
  }

  storeMessage(input: StoredMessage): void {
    const chatId = this.resolveChatId(input.chatId)
    const raw = input.rawPayload ? this.#crypto.encrypt(input.rawPayload, `message:${input.id}`) : undefined
    const isNew = !this.db.prepare('SELECT 1 FROM messages WHERE id=?').get(input.id)
    this.transaction(() => {
      this.upsertChat({ id: chatId, title: jidToLabel(chatId), kind: chatKindForJid(chatId), classificationKnown: false,
        lastMessage: input.text || attachmentPreview(input.kind), lastMessageAt: input.timestamp,
        lastMessageId: input.id,
        unreadCount: input.fromMe ? 0 : 1,
        incrementUnread: isNew && !input.fromMe && (input.incrementUnread ?? true), preserveTitle: true })
      this.db.prepare(
        `INSERT INTO messages(id, account_id, chat_id, sender_id, sender_name, from_me, kind, text, timestamp,
         status, quoted_message_id, quoted_sender_name, quoted_from_me, quoted_kind, quoted_text, rich_payload,
         edited, deleted, client_id, error, raw_payload, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET sender_name=COALESCE(excluded.sender_name, messages.sender_name), kind=excluded.kind,
         text=COALESCE(excluded.text, messages.text), status=excluded.status,
         quoted_message_id=COALESCE(excluded.quoted_message_id, messages.quoted_message_id),
         quoted_sender_name=COALESCE(excluded.quoted_sender_name, messages.quoted_sender_name),
         quoted_from_me=COALESCE(excluded.quoted_from_me, messages.quoted_from_me),
         quoted_kind=COALESCE(excluded.quoted_kind, messages.quoted_kind),
         quoted_text=COALESCE(excluded.quoted_text, messages.quoted_text),
         rich_payload=COALESCE(excluded.rich_payload, messages.rich_payload),
         edited=MAX(excluded.edited, messages.edited), deleted=MAX(excluded.deleted, messages.deleted),
         error=excluded.error, raw_payload=COALESCE(excluded.raw_payload, messages.raw_payload), updated_at=excluded.updated_at`
      ).run(input.id, ACCOUNT_ID, chatId, input.senderId ?? null, input.senderName ?? null, Number(input.fromMe),
        input.kind, input.text ?? null, input.timestamp, input.status, input.quotedMessageId ?? null,
        input.quoted?.senderName ?? null, input.quoted?.fromMe === undefined ? null : Number(input.quoted.fromMe),
        input.quoted?.kind ?? null, input.quoted?.text ?? null, input.rich ? JSON.stringify(input.rich) : null,
        Number(input.edited ?? false), Number(input.deleted ?? false), input.clientId ?? null, input.error ?? null,
        raw ?? null, Date.now())
      if (input.attachment) this.#upsertAttachment(input.id, input.attachment)
    })
  }

  getMessage(messageId: string): MessageDto {
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as Record<string, unknown> | undefined
    if (!row) throw new Error(`Message ${messageId} was not found`)
    return this.#mapMessages([row])[0]!
  }

  getRawMessage(messageId: string): Buffer | undefined {
    const row = this.db.prepare('SELECT raw_payload FROM messages WHERE id=?').get(messageId) as { raw_payload: Uint8Array | null } | undefined
    return row?.raw_payload ? this.#crypto.decrypt(row.raw_payload, `message:${messageId}`) : undefined
  }

  listMessages(chatId: string, before?: string, limitInput?: number): Page<MessageDto> {
    const cursor = decodeMessageCursor(before)
    return this.listMessagesBefore(chatId, cursor.timestamp, cursor.id, limitInput)
  }

  listMessagesBefore(chatId: string, timestamp: number, id: string, limitInput?: number): Page<MessageDto> {
    chatId = this.resolveChatId(chatId)
    const limit = Math.min(Math.max(limitInput ?? 60, 1), 100)
    const rows = this.db.prepare(
      `SELECT * FROM messages WHERE chat_id=? AND (timestamp < ? OR (timestamp = ? AND id < ?))
       ORDER BY timestamp DESC, id DESC LIMIT ?`
    ).all(chatId, timestamp, timestamp, id, limit + 1) as Record<string, unknown>[]
    const hasMore = rows.length > limit
    const selected = rows.slice(0, limit)
    const oldest = selected.at(-1)
    return { items: this.#mapMessages(selected).reverse(),
      nextCursor: hasMore && oldest ? encodeMessageCursor(Number(oldest.timestamp), String(oldest.id)) : undefined }
  }

  getMessageContext(chatId: string, messageId: string, radiusInput?: number): MessageContextDto {
    const resolvedChatId = this.resolveChatId(chatId)
    const radius = Math.min(Math.max(Math.floor(radiusInput ?? 20), 1), 50)
    const target = this.db.prepare('SELECT id, timestamp FROM messages WHERE id=? AND chat_id=?')
      .get(messageId, resolvedChatId) as { id: string; timestamp: number } | undefined
    if (!target) throw new Error('The referenced message was not found in local history')
    const before = this.db.prepare(
      `SELECT * FROM messages WHERE chat_id=? AND (timestamp < ? OR (timestamp=? AND id < ?))
       ORDER BY timestamp DESC, id DESC LIMIT ?`
    ).all(resolvedChatId, target.timestamp, target.timestamp, target.id, radius) as Record<string, unknown>[]
    const current = this.db.prepare('SELECT * FROM messages WHERE id=?').get(target.id) as Record<string, unknown>
    const after = this.db.prepare(
      `SELECT * FROM messages WHERE chat_id=? AND (timestamp > ? OR (timestamp=? AND id > ?))
       ORDER BY timestamp ASC, id ASC LIMIT ?`
    ).all(resolvedChatId, target.timestamp, target.timestamp, target.id, radius) as Record<string, unknown>[]
    return { targetId: target.id, items: this.#mapMessages([...before.reverse(), current, ...after]) }
  }

  getOldestMessageAnchor(chatId: string): MessageHistoryAnchor | undefined {
    chatId = this.resolveChatId(chatId)
    const row = this.db.prepare(
      'SELECT id, timestamp, raw_payload FROM messages WHERE chat_id=? AND raw_payload IS NOT NULL ORDER BY timestamp ASC, id ASC LIMIT 1'
    ).get(chatId) as { id: string; timestamp: number; raw_payload: Uint8Array } | undefined
    if (!row) return undefined
    return { id: row.id, timestamp: Number(row.timestamp),
      rawPayload: this.#crypto.decrypt(row.raw_payload, `message:${row.id}`) }
  }

  searchMessages(query: string, chatId?: string, cursorInput?: string): Page<MessageDto> {
    const terms = query.trim().split(/\s+/).filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"*`).join(' ')
    if (!terms) return { items: [] }
    const cursor = decodeMessageCursor(cursorInput)
    const resolvedChatId = chatId ? this.resolveChatId(chatId) : undefined
    const rows = this.db.prepare(
      `SELECT m.* FROM message_fts f JOIN messages m ON m.id=f.message_id
       WHERE message_fts MATCH ? AND (? IS NULL OR m.chat_id=?)
       AND (m.timestamp < ? OR (m.timestamp = ? AND m.id < ?))
       ORDER BY m.timestamp DESC, m.id DESC LIMIT 51`
    ).all(terms, resolvedChatId ?? null, resolvedChatId ?? null, cursor.timestamp, cursor.timestamp, cursor.id) as Record<string, unknown>[]
    const hasMore = rows.length > 50
    const selected = rows.slice(0, 50)
    const items = this.#mapMessages(selected)
    const last = selected.at(-1)
    return { items, nextCursor: hasMore && last ? encodeMessageCursor(Number(last.timestamp), String(last.id)) : undefined }
  }

  getDraft(chatId: string): DraftDto | undefined {
    chatId = this.resolveChatId(chatId)
    const row = this.db.prepare('SELECT * FROM drafts WHERE chat_id=?').get(chatId) as Record<string, unknown> | undefined
    if (!row) return undefined
    const token = nullableString(row.attachment_token)
    const attachment = token ? {
      token,
      name: nullableString(row.attachment_name) ?? 'Attachment',
      size: Number(row.attachment_size ?? 0),
      mimeType: nullableString(row.attachment_mime) ?? 'application/octet-stream',
      previewUrl: `warish-media://drafts/${encodeURIComponent(token)}`
    } satisfies PickedAttachment : undefined
    return {
      chatId,
      text: nullableString(row.text) ?? '',
      attachment,
      attachmentKind: attachmentKindValue(row.attachment_kind),
      updatedAt: Number(row.updated_at)
    }
  }

  saveDraft(input: DraftDto): void {
    const chatId = this.resolveChatId(input.chatId)
    if (!input.text && !input.attachment) {
      this.clearDraft(chatId)
      return
    }
    this.db.prepare(
      `INSERT INTO drafts(chat_id, text, attachment_token, attachment_kind, attachment_name, attachment_size, attachment_mime, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET text=excluded.text, attachment_token=excluded.attachment_token,
       attachment_kind=excluded.attachment_kind, attachment_name=excluded.attachment_name,
       attachment_size=excluded.attachment_size, attachment_mime=excluded.attachment_mime, updated_at=excluded.updated_at`
    ).run(chatId, input.text, input.attachment?.token ?? null, input.attachmentKind ?? null,
      input.attachment?.name ?? null, input.attachment?.size ?? null, input.attachment?.mimeType ?? null, Date.now())
  }

  clearDraft(chatId: string): void {
    this.db.prepare('DELETE FROM drafts WHERE chat_id=?').run(this.resolveChatId(chatId))
  }

  referencedDraftTokens(): Set<string> {
    const rows = this.db.prepare(
      `SELECT attachment_token AS token FROM drafts WHERE attachment_token IS NOT NULL
       UNION SELECT draft_token AS token FROM attachments WHERE draft_token IS NOT NULL`
    ).all() as Array<{ token: string }>
    return new Set(rows.map((row) => row.token))
  }

  updateMessageStatus(messageId: string, status: DeliveryState, error?: string): void {
    this.db.prepare('UPDATE messages SET status=?, error=?, updated_at=? WHERE id=?').run(status, error ?? null, Date.now(), messageId)
  }

  getOutboxForMessage(messageId: string): { clientId: string; payload: Record<string, unknown> } | undefined {
    const row = this.db.prepare(
      `SELECT o.client_id, o.payload FROM outbox o JOIN messages m ON m.client_id=o.client_id WHERE m.id=? AND o.state='failed'`
    ).get(messageId) as { client_id: string; payload: string } | undefined
    if (!row) return undefined
    try { return { clientId: row.client_id, payload: JSON.parse(row.payload) as Record<string, unknown> } }
    catch { return undefined }
  }

  deleteOutbox(clientId: string): void {
    this.db.prepare('DELETE FROM outbox WHERE client_id=?').run(clientId)
  }

  markInterruptedSendsFailed(): number {
    const now = Date.now()
    return Number(this.transaction(() => {
      const result = this.db.prepare(
        `UPDATE messages SET status='failed', error='Sending was interrupted. Retry when connected.', updated_at=?
         WHERE client_id IN (SELECT client_id FROM outbox WHERE state='sending')`
      ).run(now)
      this.db.prepare(
        `UPDATE outbox SET state='failed', error='Sending was interrupted. Retry when connected.', updated_at=? WHERE state='sending'`
      ).run(now)
      return result.changes
    }))
  }

  upsertReaction(messageId: string, senderId: string, emoji?: string): void {
    if (!emoji) {
      this.db.prepare('DELETE FROM reactions WHERE message_id=? AND sender_id=?').run(messageId, senderId)
      return
    }
    this.db.prepare(
      `INSERT INTO reactions(message_id, sender_id, emoji) VALUES (?, ?, ?)
       ON CONFLICT(message_id, sender_id) DO UPDATE SET emoji=excluded.emoji`
    ).run(messageId, senderId, emoji)
  }

  enqueueOutbox(clientId: string, chatId: string, payload: unknown): void {
    const now = Date.now()
    this.db.prepare(
      `INSERT INTO outbox(client_id, chat_id, payload, state, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET payload=excluded.payload, state='queued', error=NULL, updated_at=excluded.updated_at`
    ).run(clientId, this.resolveChatId(chatId), JSON.stringify(payload), now, now)
  }

  updateOutbox(clientId: string, state: 'sending' | 'sent' | 'failed', error?: string): void {
    this.db.prepare(
      `UPDATE outbox SET state=?, attempts=attempts+CASE WHEN ?='sending' THEN 1 ELSE 0 END, error=?, updated_at=? WHERE client_id=?`
    ).run(state, state, error ?? null, Date.now(), clientId)
  }

  latestIncomingMessageId(chatId: string): string | undefined {
    const row = this.db.prepare(
      'SELECT id FROM messages WHERE chat_id=? AND from_me=0 ORDER BY timestamp DESC, id DESC LIMIT 1'
    ).get(this.resolveChatId(chatId)) as { id: string } | undefined
    return row?.id
  }

  markMessageEdited(messageId: string, text: string): void {
    this.transaction(() => {
      this.db.prepare('UPDATE messages SET text=?, edited=1, updated_at=? WHERE id=?').run(text, Date.now(), messageId)
      this.db.prepare('UPDATE chats SET last_message=?, updated_at=? WHERE last_message_id=?').run(text, Date.now(), messageId)
    })
  }

  markMessageDeleted(messageId: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE messages SET text=NULL, deleted=1, kind='system', updated_at=? WHERE id=?").run(Date.now(), messageId)
      this.db.prepare("UPDATE chats SET last_message='This message was deleted', updated_at=? WHERE last_message_id=?")
        .run(Date.now(), messageId)
    })
  }

  getSettings(): AppSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='application'").get() as { value: string } | undefined
    if (!row) return { ...DEFAULT_SETTINGS }
    try { return sanitizeSettings(JSON.parse(row.value) as Partial<AppSettings>) }
    catch { return { ...DEFAULT_SETTINGS } }
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const definedPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<AppSettings>
    if (definedPatch.historySyncDays !== undefined) {
      definedPatch.historySyncDays = Math.min(3_650, Math.max(1, Math.floor(definedPatch.historySyncDays)))
    }
    const settings = sanitizeSettings({ ...this.getSettings(), ...definedPatch })
    this.db.prepare(
      "INSERT INTO settings(key, value, updated_at) VALUES ('application', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
    ).run(JSON.stringify(settings), Date.now())
    return settings
  }

  pruneMessagesBefore(cutoff: number): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE timestamp < ?').run(cutoff)
      this.db.prepare(
        `UPDATE chats SET
          last_message=(SELECT ${SQL_MESSAGE_PREVIEW} FROM messages m WHERE m.chat_id=chats.id ORDER BY m.timestamp DESC, m.id DESC LIMIT 1),
          last_message_at=(SELECT m.timestamp FROM messages m WHERE m.chat_id=chats.id ORDER BY m.timestamp DESC, m.id DESC LIMIT 1),
          last_message_id=(SELECT m.id FROM messages m WHERE m.chat_id=chats.id ORDER BY m.timestamp DESC, m.id DESC LIMIT 1),
          unread_count=MIN(unread_count, (SELECT COUNT(*) FROM messages m WHERE m.chat_id=chats.id AND m.from_me=0)),
          updated_at=?`
      ).run(Date.now())
    })
  }

  saveMediaToken(messageId: string, token: string, size?: number): void {
    this.db.prepare("UPDATE attachments SET cache_token=?, draft_token=NULL, size=COALESCE(?, size), download_state='ready' WHERE message_id=?")
      .run(token, size ?? null, messageId)
  }

  clearMediaToken(messageId: string): void {
    this.db.prepare("UPDATE attachments SET cache_token=NULL, download_state='remote' WHERE message_id=?").run(messageId)
  }

  clearMediaTokens(tokens?: string[]): void {
    if (!tokens) {
      this.db.prepare("UPDATE attachments SET cache_token=NULL, download_state='remote' WHERE cache_token IS NOT NULL").run()
      return
    }
    if (!tokens.length) return
    const placeholders = tokens.map(() => '?').join(', ')
    this.db.prepare(
      `UPDATE attachments SET cache_token=NULL, download_state='remote' WHERE cache_token IN (${placeholders})`
    ).run(...tokens)
  }

  setMediaDownloadState(messageId: string, state: AttachmentDto['downloadState']): void {
    this.db.prepare('UPDATE attachments SET download_state=? WHERE message_id=?').run(state, messageId)
  }

  shouldFetchMediaThumbnail(messageId: string, now = Date.now()): boolean {
    const row = this.db.prepare(
      `SELECT kind, thumbnail_data_url, cache_token, thumbnail_missing_until
       FROM attachments WHERE message_id=?`
    ).get(messageId) as {
      kind?: string
      thumbnail_data_url?: string
      cache_token?: string
      thumbnail_missing_until?: number
    } | undefined
    if (!row || (row.kind !== 'image' && row.kind !== 'video')) return false
    if (row.thumbnail_data_url || row.cache_token) return false
    return Number(row.thumbnail_missing_until ?? 0) <= now
  }

  saveMediaThumbnail(messageId: string, thumbnailDataUrl: string): void {
    const now = Date.now()
    this.db.prepare(
      `UPDATE attachments SET thumbnail_data_url=?, thumbnail_checked_at=?, thumbnail_missing_until=NULL,
       thumbnail_failures=0 WHERE message_id=?`
    ).run(thumbnailDataUrl, now, messageId)
  }

  markMediaThumbnailUnavailable(messageId: string, retryAfterMs: number): void {
    const now = Date.now()
    this.db.prepare(
      `UPDATE attachments SET thumbnail_checked_at=?, thumbnail_missing_until=?,
       thumbnail_failures=thumbnail_failures+1 WHERE message_id=?`
    ).run(now, now + Math.max(1_000, retryAfterMs), messageId)
  }

  #upsertAttachment(messageId: string, input: Omit<AttachmentDto, 'messageId'>): void {
    this.db.prepare(
      `INSERT INTO attachments(id, message_id, kind, file_name, mime_type, size, width, height, duration_seconds,
       thumbnail_data_url, cache_token, draft_token, download_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET file_name=COALESCE(excluded.file_name, attachments.file_name),
       mime_type=COALESCE(excluded.mime_type, attachments.mime_type), size=COALESCE(excluded.size, attachments.size),
       width=COALESCE(excluded.width, attachments.width), height=COALESCE(excluded.height, attachments.height),
       duration_seconds=COALESCE(excluded.duration_seconds, attachments.duration_seconds),
       thumbnail_data_url=COALESCE(excluded.thumbnail_data_url, attachments.thumbnail_data_url),
       cache_token=COALESCE(excluded.cache_token, attachments.cache_token),
       draft_token=COALESCE(excluded.draft_token, attachments.draft_token),
       download_state=CASE WHEN attachments.cache_token IS NOT NULL THEN 'ready' ELSE excluded.download_state END`
    ).run(input.id, messageId, input.kind, input.fileName ?? null, input.mimeType ?? null, input.size ?? null,
      input.width ?? null, input.height ?? null, input.durationSeconds ?? null, input.thumbnailDataUrl ?? null,
      input.cacheToken ?? null, input.draftToken ?? null, input.downloadState)
  }

  #mapMessages(rows: Record<string, unknown>[]): MessageDto[] {
    if (!rows.length) return []
    const ids = rows.map((row) => String(row.id))
    const messagePlaceholders = ids.map(() => '?').join(', ')
    const attachmentRows = this.db.prepare(`SELECT * FROM attachments WHERE message_id IN (${messagePlaceholders})`)
      .all(...ids) as Record<string, unknown>[]
    const attachmentByMessage = new Map(attachmentRows.map((row) => [String(row.message_id), mapAttachment(row)]))
    const reactionRows = this.db.prepare(
      `SELECT message_id, sender_id, emoji FROM reactions WHERE message_id IN (${messagePlaceholders})`
    ).all(...ids) as Array<{ message_id: string; sender_id: string; emoji: string }>
    const reactionsByMessage = new Map<string, Array<{ senderId: string; emoji: string }>>()
    for (const reaction of reactionRows) {
      const current = reactionsByMessage.get(reaction.message_id) ?? []
      current.push({ senderId: reaction.sender_id, emoji: reaction.emoji })
      reactionsByMessage.set(reaction.message_id, current)
    }

    const quotedIds = [...new Set(rows.map((row) => nullableString(row.quoted_message_id)).filter((id): id is string => Boolean(id)))]
    const quotedTargets = new Map<string, Record<string, unknown>>()
    if (quotedIds.length) {
      const placeholders = quotedIds.map(() => '?').join(', ')
      const targets = this.db.prepare(
        `SELECT id, sender_name, from_me, kind, text, deleted FROM messages WHERE id IN (${placeholders})`
      ).all(...quotedIds) as Record<string, unknown>[]
      for (const target of targets) quotedTargets.set(String(target.id), target)
    }

    const senderIds = [...new Set(rows.map((row) => nullableString(row.sender_id)).filter((id): id is string => Boolean(id)))]
    const senderNames = new Map<string, string>()
    if (senderIds.length) {
      const placeholders = senderIds.map(() => '?').join(', ')
      const contacts = this.db.prepare(
        `SELECT identity_alias.alias_id, identity.saved_name, identity.whatsapp_name
         FROM contact_identity_aliases identity_alias
         JOIN contact_identities identity ON identity.identity_id=identity_alias.identity_id
         WHERE identity_alias.alias_id IN (${placeholders})`
      ).all(...senderIds) as Record<string, unknown>[]
      for (const contact of contacts) {
        const name = validContactName(nullableString(contact.saved_name)) ?? validContactName(nullableString(contact.whatsapp_name))
        if (!name) continue
        const alias = nullableString(contact.alias_id)
        if (alias && !senderNames.has(alias)) senderNames.set(alias, name)
      }
    }

    return rows.map((row) => {
      const id = String(row.id)
      const senderId = nullableString(row.sender_id)
      const quotedMessageId = nullableString(row.quoted_message_id)
      const quotedTarget = quotedMessageId ? quotedTargets.get(quotedMessageId) : undefined
      const quoted = quotedMessageId ? {
        id: quotedMessageId,
        senderName: nullableString(quotedTarget?.sender_name) ?? nullableString(row.quoted_sender_name),
        fromMe: quotedTarget ? Boolean(quotedTarget.from_me) : nullableBoolean(row.quoted_from_me),
        kind: (quotedTarget?.kind ?? row.quoted_kind ?? 'unsupported') as MessageKind,
        text: quotedTarget?.deleted ? 'This message was deleted' : nullableString(quotedTarget?.text) ?? nullableString(row.quoted_text)
      } satisfies QuotedMessageDto : undefined
      return { id, chatId: String(row.chat_id), senderId,
        senderName: (senderId ? senderNames.get(senderId) : undefined) ?? nullableString(row.sender_name),
        fromMe: Boolean(row.from_me), kind: row.kind as MessageKind,
        text: nullableString(row.text), timestamp: Number(row.timestamp), status: row.status as DeliveryState,
        quotedMessageId, quoted, rich: parseRichMessage(row.rich_payload), edited: Boolean(row.edited), deleted: Boolean(row.deleted),
        clientId: nullableString(row.client_id), error: nullableString(row.error),
        reactions: reactionsByMessage.get(id) ?? [], attachment: attachmentByMessage.get(id) }
    })
  }

  #upsertChatAlias(aliasId: string, canonicalId: string): void {
    if (!aliasId || aliasId === canonicalId) return
    this.db.prepare(
      `INSERT INTO chat_aliases(alias_id, canonical_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(alias_id) DO UPDATE SET canonical_id=excluded.canonical_id, updated_at=excluded.updated_at`
    ).run(aliasId, canonicalId, Date.now())
  }

  #mergeDirectChats(canonicalId: string, aliases: string[]): ChatMergeResult {
    const candidates = [...new Set([canonicalId, ...aliases].filter(Boolean))]
    const placeholders = candidates.map(() => '?').join(', ')
    const rows = this.db.prepare(`SELECT * FROM chats WHERE id IN (${placeholders})`).all(...candidates) as Record<string, unknown>[]
    if (!rows.length) return { chatId: canonicalId, mergedChatIds: [] }
    const existingCanonical = rows.find((row) => String(row.id) === canonicalId)
    const source = existingCanonical ?? [...rows].sort((left, right) => Number(right.updated_at) - Number(left.updated_at))[0]!
    if (!existingCanonical) {
      this.db.prepare(
        `INSERT INTO chats(id, account_id, title, kind, avatar_url, last_message, last_message_at, last_message_id,
         unread_count, archived, pinned, muted_until, updated_at) VALUES (?, ?, ?, 'direct', ?, NULL, NULL, NULL, 0, 0, 0, NULL, ?)`
      ).run(canonicalId, ACCOUNT_ID, String(source.title), nullableString(source.avatar_url) ?? null, Date.now())
    }
    const mergedChatIds = rows.map((row) => String(row.id)).filter((id) => id !== canonicalId)
    if (!mergedChatIds.length) return { chatId: canonicalId, mergedChatIds: [] }

    const draftRows = this.db.prepare(`SELECT * FROM drafts WHERE chat_id IN (${placeholders}) ORDER BY updated_at DESC`)
      .all(...candidates) as Record<string, unknown>[]
    this.db.prepare(`DELETE FROM drafts WHERE chat_id IN (${placeholders})`).run(...candidates)
    const newestDraft = draftRows[0]
    if (newestDraft) this.db.prepare(
      `INSERT INTO drafts(chat_id, text, attachment_token, attachment_kind, attachment_name, attachment_size, attachment_mime, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(canonicalId, nullableString(newestDraft.text) ?? '', nullableString(newestDraft.attachment_token) ?? null,
      nullableString(newestDraft.attachment_kind) ?? null, nullableString(newestDraft.attachment_name) ?? null,
      nullableNumber(newestDraft.attachment_size) ?? null, nullableString(newestDraft.attachment_mime) ?? null,
      Number(newestDraft.updated_at))

    this.db.prepare(`UPDATE messages SET chat_id=?, updated_at=? WHERE chat_id IN (${placeholders})`)
      .run(canonicalId, Date.now(), ...candidates)
    this.db.prepare(`UPDATE outbox SET chat_id=?, updated_at=? WHERE chat_id IN (${placeholders})`)
      .run(canonicalId, Date.now(), ...candidates)
    if (this.#crmSchemaAvailable()) {
      this.db.prepare(`UPDATE crm_contacts SET chat_id=?, updated_at=? WHERE chat_id IN (${placeholders})`)
        .run(canonicalId, Date.now(), ...candidates)
    }

    const bestTitle = rows.map((row) => String(row.title)).filter((title) => title && !/^\+?\d+$/.test(title) && title !== 'Group')
      .sort((left, right) => right.length - left.length)[0] ?? String(source.title)
    const unreadCount = Math.max(...rows.map((row) => Number(row.unread_count ?? 0)))
    const archived = rows.every((row) => Boolean(row.archived))
    const pinned = rows.some((row) => Boolean(row.pinned))
    const mutedUntil = Math.max(0, ...rows.map((row) => Number(row.muted_until ?? 0))) || null
    const avatarUrl = rows.map((row) => nullableString(row.avatar_url)).find(Boolean) ?? null
    this.db.prepare(
      `UPDATE chats SET title=?, avatar_url=?, unread_count=?, archived=?, pinned=?, muted_until=?, updated_at=? WHERE id=?`
    ).run(bestTitle, avatarUrl, unreadCount, Number(archived), Number(pinned), mutedUntil, Date.now(), canonicalId)
    this.db.prepare(`DELETE FROM chats WHERE id IN (${mergedChatIds.map(() => '?').join(', ')})`).run(...mergedChatIds)
    for (const alias of mergedChatIds) this.#upsertChatAlias(alias, canonicalId)
    this.#repairChatPreview(canonicalId)
    return { chatId: canonicalId, mergedChatIds }
  }

  #repairChatPreview(chatId: string): void {
    this.db.prepare(
      `UPDATE chats SET
       last_message=(SELECT ${SQL_MESSAGE_PREVIEW} FROM messages m WHERE m.chat_id=chats.id ORDER BY m.timestamp DESC, m.id DESC LIMIT 1),
       last_message_at=(SELECT m.timestamp FROM messages m WHERE m.chat_id=chats.id ORDER BY m.timestamp DESC, m.id DESC LIMIT 1),
       last_message_id=(SELECT m.id FROM messages m WHERE m.chat_id=chats.id ORDER BY m.timestamp DESC, m.id DESC LIMIT 1),
       updated_at=? WHERE id=?`
    ).run(Date.now(), chatId)
  }

  #upsertCanonicalContact(input: {
    id: string
    lid?: string
    phoneNumber?: string
    name?: string
    pushName?: string
  }): string {
    const rawId = input.id.trim()
    const normalizedId = normalizeContactAlias(rawId)
    const lid = input.lid
      ? normalizeDirectJid(input.lid, 'lid')
      : isLidIdentity(rawId) ? normalizeDirectJid(rawId, 'lid') : undefined
    const phoneNumber = normalizePhoneNumber(input.phoneNumber) ?? phoneNumberFromJid(rawId)
    const phoneJid = phoneNumber ? `${phoneNumber}@s.whatsapp.net`
      : isPhoneIdentity(rawId) ? normalizeDirectJid(rawId, 's.whatsapp.net') : undefined
    const aliases = [...new Set([rawId, normalizedId, lid, phoneJid].filter((value): value is string => Boolean(value)))]
    const placeholders = aliases.map(() => '?').join(', ')
    const candidates = this.db.prepare(
      `SELECT identity.* FROM contact_identities identity
       WHERE identity.identity_id IN (
         SELECT identity_id FROM contact_identity_aliases WHERE alias_id IN (${placeholders})
       ) OR identity.lid=? OR identity.phone_jid=? OR identity.phone_number=?
       ORDER BY identity.updated_at DESC`
    ).all(...aliases, lid ?? null, phoneJid ?? null, phoneNumber ?? null) as Record<string, unknown>[]
    const target = candidates.find((row) => lid && row.lid === lid)
      ?? candidates.find((row) => phoneJid && row.phone_jid === phoneJid)
      ?? candidates[0]
    const identityId = target ? String(target.identity_id) : lid ?? phoneJid ?? normalizedId
    const savedName = validContactName(input.name)
      ?? candidates.map((row) => validContactName(nullableString(row.saved_name))).find(Boolean)
    const whatsappName = validContactName(input.pushName)
      ?? candidates.map((row) => validContactName(nullableString(row.whatsapp_name))).find(Boolean)
    const avatarToken = candidates.map((row) => nullableString(row.avatar_token)).find(Boolean)
    const avatarCheckedAt = Math.max(0, ...candidates.map((row) => Number(row.avatar_checked_at ?? 0))) || undefined
    const avatarMissingUntil = Math.max(0, ...candidates.map((row) => Number(row.avatar_missing_until ?? 0))) || undefined
    const avatarFailures = candidates.reduce((total, row) => total + Number(row.avatar_failures ?? 0), 0)
    const now = Date.now()
    const preferredChatId = lid ?? phoneJid ?? normalizedId

    this.transaction(() => {
      this.db.prepare(
        `INSERT OR IGNORE INTO contact_identities(identity_id, lid, phone_jid, phone_number, saved_name,
         whatsapp_name, avatar_token, avatar_checked_at, avatar_missing_until, avatar_failures, updated_at)
         VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?)`
      ).run(identityId, now)
      for (const candidate of candidates) {
        const candidateId = String(candidate.identity_id)
        if (candidateId === identityId) continue
        this.#mergeCrmIdentity(candidateId, identityId, preferredChatId, now)
        this.db.prepare('UPDATE contact_identity_aliases SET identity_id=?, updated_at=? WHERE identity_id=?')
          .run(identityId, now, candidateId)
        this.db.prepare('DELETE FROM contact_identities WHERE identity_id=?').run(candidateId)
      }
      this.db.prepare(
        `UPDATE contact_identities SET lid=COALESCE(?, lid), phone_jid=COALESCE(?, phone_jid),
         phone_number=COALESCE(?, phone_number), saved_name=COALESCE(?, saved_name),
         whatsapp_name=COALESCE(?, whatsapp_name), avatar_token=COALESCE(?, avatar_token),
         avatar_checked_at=COALESCE(?, avatar_checked_at), avatar_missing_until=COALESCE(?, avatar_missing_until),
         avatar_failures=MAX(avatar_failures, ?), updated_at=? WHERE identity_id=?`
      ).run(lid ?? null, phoneJid ?? null, phoneNumber ?? null, savedName ?? null, whatsappName ?? null,
        avatarToken ?? null, avatarCheckedAt ?? null, avatarMissingUntil ?? null, avatarFailures, now, identityId)
      for (const alias of aliases) {
        this.db.prepare(
          `INSERT INTO contact_identity_aliases(alias_id, identity_id, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(alias_id) DO UPDATE SET identity_id=excluded.identity_id, updated_at=excluded.updated_at`
        ).run(alias, identityId, now)
      }
      if (this.#crmSchemaAvailable()) {
        this.db.prepare('UPDATE crm_contacts SET chat_id=?, updated_at=? WHERE identity_id=?')
          .run(preferredChatId, now, identityId)
      }
    })
    return identityId
  }

  #crmSchemaAvailable(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='crm_contacts'").get())
  }

  #mergeCrmIdentity(sourceIdentityId: string, targetIdentityId: string, chatId: string, now: number): void {
    if (!this.#crmSchemaAvailable()) return
    const source = this.db.prepare('SELECT * FROM crm_contacts WHERE identity_id=?').get(sourceIdentityId) as Record<string, unknown> | undefined
    if (!source) return
    const target = this.db.prepare('SELECT * FROM crm_contacts WHERE identity_id=?').get(targetIdentityId) as Record<string, unknown> | undefined
    const sourceContactId = String(source.id)
    if (!target) {
      this.db.prepare('UPDATE crm_contacts SET identity_id=?, chat_id=?, updated_at=? WHERE id=?')
        .run(targetIdentityId, chatId, now, sourceContactId)
      return
    }

    const targetContactId = String(target.id)
    if (targetContactId === sourceContactId) return
    this.db.prepare(`INSERT OR IGNORE INTO crm_contact_tags(contact_id, tag_id)
      SELECT ?, tag_id FROM crm_contact_tags WHERE contact_id=?`).run(targetContactId, sourceContactId)
    this.db.prepare('DELETE FROM crm_contact_tags WHERE contact_id=?').run(sourceContactId)
    for (const table of ['crm_notes', 'crm_orders', 'crm_tasks', 'crm_activity'] as const) {
      this.db.prepare(`UPDATE ${table} SET contact_id=? WHERE contact_id=?`).run(targetContactId, sourceContactId)
    }

    const lifecycleRank: Record<string, number> = { spam: 0, ignored: 1, lead: 2, customer: 3 }
    const lifecycle = (lifecycleRank[String(source.lifecycle)] ?? -1) > (lifecycleRank[String(target.lifecycle)] ?? -1)
      ? String(source.lifecycle) : String(target.lifecycle)
    const stageRank: Record<string, number> = {
      'stage-new': 0, 'stage-qualified': 1, 'stage-quoted': 2, 'stage-lost': 3, 'stage-won': 4
    }
    const stageId = lifecycle === 'customer' ? 'stage-won'
      : (stageRank[String(source.stage_id)] ?? -1) > (stageRank[String(target.stage_id)] ?? -1)
        ? String(source.stage_id) : String(target.stage_id)
    const mergedCustomFields = {
      ...parseJsonRecord(source.custom_fields),
      ...parseJsonRecord(target.custom_fields)
    }
    this.db.prepare(`UPDATE crm_contacts SET identity_id=?, chat_id=?, lifecycle=?, stage_id=?,
      name=COALESCE(NULLIF(name, ''), ?), email=COALESCE(NULLIF(email, ''), ?), company=COALESCE(NULLIF(company, ''), ?),
      address=COALESCE(NULLIF(address, ''), ?), birthday=COALESCE(NULLIF(birthday, ''), ?), tax_id=COALESCE(NULLIF(tax_id, ''), ?),
      preferences=COALESCE(NULLIF(preferences, ''), ?), consent_status=CASE WHEN consent_status='unknown' THEN ? ELSE consent_status END,
      do_not_contact=MAX(do_not_contact, ?), custom_fields=?, created_at=MIN(created_at, ?),
      last_activity_at=MAX(last_activity_at, ?), updated_at=? WHERE id=?`)
      .run(targetIdentityId, chatId, lifecycle, stageId, nullableString(source.name) ?? null,
        nullableString(source.email) ?? null, nullableString(source.company) ?? null,
        nullableString(source.address) ?? null, nullableString(source.birthday) ?? null,
        nullableString(source.tax_id) ?? null, nullableString(source.preferences) ?? null,
        nullableString(source.consent_status) ?? 'unknown', Number(source.do_not_contact ?? 0), JSON.stringify(mergedCustomFields),
        Number(source.created_at), Number(source.last_activity_at), now, targetContactId)
    this.db.prepare('DELETE FROM crm_contacts WHERE id=?').run(sourceContactId)
  }

  rebuildCanonicalContacts(): { contacts: number; directChats: number } {
    const contacts = this.db.prepare(
      'SELECT id, lid, phone_number, name, push_name FROM contacts ORDER BY updated_at ASC, id ASC'
    ).all() as Record<string, unknown>[]
    const directChats = this.db.prepare("SELECT id FROM chats WHERE kind='direct' ORDER BY updated_at ASC, id ASC")
      .all() as Array<{ id: string }>
    this.transaction(() => {
      for (const contact of contacts) this.#upsertCanonicalContact({
        id: String(contact.id),
        lid: nullableString(contact.lid),
        phoneNumber: nullableString(contact.phone_number),
        name: nullableString(contact.name),
        pushName: nullableString(contact.push_name)
      })
      for (const chat of directChats) this.#upsertCanonicalContact({ id: chat.id })
    })
    const result = { contacts: contacts.length, directChats: directChats.length }
    this.#logger.info(result, 'canonical contact identity index built')
    return result
  }

  #migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);')
    const version = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number }
    if (version.version < 1) {
      this.#logger.info({ version: 1 }, 'applying database migration')
      this.transaction(() => this.db.exec(`
      CREATE TABLE accounts(id TEXT PRIMARY KEY, phone_number TEXT, display_name TEXT, created_at INTEGER NOT NULL, linked_at INTEGER);
      CREATE TABLE contacts(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, jid TEXT NOT NULL, lid TEXT, phone_number TEXT,
        name TEXT, push_name TEXT, avatar_url TEXT, updated_at INTEGER NOT NULL);
      CREATE INDEX contacts_account_idx ON contacts(account_id);
      CREATE TABLE chats(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL,
        avatar_url TEXT, last_message TEXT, last_message_at INTEGER, unread_count INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, muted_until INTEGER, updated_at INTEGER NOT NULL);
      CREATE INDEX chats_order_idx ON chats(account_id, archived, pinned, last_message_at DESC);
      CREATE TABLE messages(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, chat_id TEXT NOT NULL, sender_id TEXT,
        sender_name TEXT, from_me INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT, timestamp INTEGER NOT NULL,
        status TEXT NOT NULL, quoted_message_id TEXT, edited INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
        client_id TEXT UNIQUE, error TEXT, raw_payload BLOB, updated_at INTEGER NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE);
      CREATE INDEX messages_chat_time_idx ON messages(chat_id, timestamp DESC, id DESC);
      CREATE TABLE attachments(id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, file_name TEXT,
        mime_type TEXT, size INTEGER, width INTEGER, height INTEGER, duration_seconds REAL, thumbnail_data_url TEXT,
        cache_token TEXT, download_state TEXT NOT NULL, FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE);
      CREATE TABLE reactions(message_id TEXT NOT NULL, sender_id TEXT NOT NULL, emoji TEXT NOT NULL,
        PRIMARY KEY(message_id, sender_id), FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE);
      CREATE TABLE receipts(message_id TEXT NOT NULL, sender_id TEXT NOT NULL, state TEXT NOT NULL, timestamp INTEGER NOT NULL,
        PRIMARY KEY(message_id, sender_id, state), FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE);
      CREATE TABLE drafts(chat_id TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE outbox(client_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE sync_state(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE auth_store(account_id TEXT NOT NULL, category TEXT NOT NULL, key_id TEXT NOT NULL, value BLOB NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY(account_id, category, key_id));
      CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE VIRTUAL TABLE message_fts USING fts5(message_id UNINDEXED, chat_id UNINDEXED, text, tokenize='unicode61');
      CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages WHEN NEW.text IS NOT NULL BEGIN
        INSERT INTO message_fts(message_id, chat_id, text) VALUES (NEW.id, NEW.chat_id, NEW.text); END;
      CREATE TRIGGER messages_fts_update AFTER UPDATE OF text ON messages BEGIN DELETE FROM message_fts WHERE message_id=OLD.id;
        INSERT INTO message_fts(message_id, chat_id, text) SELECT NEW.id, NEW.chat_id, NEW.text WHERE NEW.text IS NOT NULL; END;
      CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN DELETE FROM message_fts WHERE message_id=OLD.id; END;
      INSERT INTO accounts(id, created_at) VALUES ('primary', CAST(strftime('%s','now') AS INTEGER) * 1000);
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, CAST(strftime('%s','now') AS INTEGER) * 1000);
      `))
    }
    if (version.version < 2) {
      this.#logger.info({ version: 2 }, 'applying database migration')
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE chats ADD COLUMN last_message_id TEXT;
          CREATE INDEX chats_order_v2_idx ON chats(account_id, archived, pinned DESC, last_message_at DESC, id DESC);
        `)
        const placeholders = CONTROL_PLACEHOLDER_TEXT.map(() => '?').join(', ')
        this.db.prepare(`DELETE FROM messages WHERE kind='unsupported' AND text IN (${placeholders})`)
          .run(...CONTROL_PLACEHOLDER_TEXT)
        this.db.prepare(`DELETE FROM chats WHERE last_message IN (${placeholders}) AND NOT EXISTS
          (SELECT 1 FROM messages m WHERE m.chat_id=chats.id)`).run(...CONTROL_PLACEHOLDER_TEXT)
        this.db.exec(`
          UPDATE chats SET
            last_message=(SELECT ${SQL_MESSAGE_PREVIEW} FROM messages m WHERE m.chat_id=chats.id
              ORDER BY m.timestamp DESC, m.id DESC LIMIT 1),
            last_message_at=(SELECT m.timestamp FROM messages m WHERE m.chat_id=chats.id
              ORDER BY m.timestamp DESC, m.id DESC LIMIT 1),
            last_message_id=(SELECT m.id FROM messages m WHERE m.chat_id=chats.id
              ORDER BY m.timestamp DESC, m.id DESC LIMIT 1),
            updated_at=CAST(strftime('%s','now') AS INTEGER) * 1000;
          INSERT INTO schema_migrations(version, applied_at) VALUES
            (2, CAST(strftime('%s','now') AS INTEGER) * 1000);
        `)
      })
    }
    if (version.version < 3) {
      this.#logger.info({ version: 3 }, 'applying database migration')
      this.transaction(() => this.db.exec(`
        CREATE INDEX IF NOT EXISTS contacts_jid_idx ON contacts(jid);
        CREATE INDEX IF NOT EXISTS contacts_lid_idx ON contacts(lid);
        CREATE INDEX IF NOT EXISTS contacts_phone_idx ON contacts(phone_number);
        INSERT INTO schema_migrations(version, applied_at) VALUES
          (3, CAST(strftime('%s','now') AS INTEGER) * 1000);
      `))
    }
    if (version.version < 4) {
      this.#logger.info({ version: 4 }, 'applying database migration')
      this.transaction(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS chat_aliases(
          alias_id TEXT PRIMARY KEY,
          canonical_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS chat_aliases_canonical_idx ON chat_aliases(canonical_id);
        ALTER TABLE messages ADD COLUMN quoted_sender_name TEXT;
        ALTER TABLE messages ADD COLUMN quoted_from_me INTEGER;
        ALTER TABLE messages ADD COLUMN quoted_kind TEXT;
        ALTER TABLE messages ADD COLUMN quoted_text TEXT;
        ALTER TABLE messages ADD COLUMN rich_payload TEXT;
        INSERT INTO schema_migrations(version, applied_at) VALUES
          (4, CAST(strftime('%s','now') AS INTEGER) * 1000);
      `))
    }
    if (version.version < 5) {
      this.#logger.info({ version: 5 }, 'applying database migration')
      this.transaction(() => this.db.exec(`
        ALTER TABLE drafts ADD COLUMN attachment_token TEXT;
        ALTER TABLE drafts ADD COLUMN attachment_kind TEXT;
        ALTER TABLE drafts ADD COLUMN attachment_name TEXT;
        ALTER TABLE drafts ADD COLUMN attachment_size INTEGER;
        ALTER TABLE drafts ADD COLUMN attachment_mime TEXT;
        ALTER TABLE attachments ADD COLUMN draft_token TEXT;
        DROP TRIGGER IF EXISTS messages_fts_update;
        CREATE TRIGGER messages_fts_update AFTER UPDATE OF text, chat_id ON messages BEGIN
          DELETE FROM message_fts WHERE message_id=OLD.id;
          INSERT INTO message_fts(message_id, chat_id, text)
            SELECT NEW.id, NEW.chat_id, NEW.text WHERE NEW.text IS NOT NULL;
        END;
        DELETE FROM message_fts;
        INSERT INTO message_fts(message_id, chat_id, text)
          SELECT id, chat_id, text FROM messages WHERE text IS NOT NULL;
        DELETE FROM chats WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_id=chats.id)
          AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.chat_id=chats.id)
          AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.chat_id=chats.id AND o.state IN ('queued', 'sending', 'failed'));
        INSERT INTO schema_migrations(version, applied_at) VALUES
          (5, CAST(strftime('%s','now') AS INTEGER) * 1000);
      `))
    }
    if (version.version < 6) {
      this.#logger.info({ version: 6 }, 'applying database migration')
      this.transaction(() => this.db.exec(`
        ALTER TABLE chats ADD COLUMN community_id TEXT;
        ALTER TABLE chats ADD COLUMN is_community_announcement INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE chats ADD COLUMN description TEXT;
        UPDATE chats SET kind='channel' WHERE id LIKE '%@newsletter';
        CREATE INDEX chats_category_order_v6_idx ON chats(
          account_id, archived, kind, pinned DESC, last_message_at DESC, id DESC
        );
        CREATE INDEX chats_community_v6_idx ON chats(community_id, is_community_announcement DESC, last_message_at DESC, id DESC);
        INSERT INTO schema_migrations(version, applied_at) VALUES
          (6, CAST(strftime('%s','now') AS INTEGER) * 1000);
      `))
    }
    if (version.version < 7) {
      this.#logger.info({ version: 7 }, 'applying database migration')
      this.transaction(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS contact_identities(
          identity_id TEXT PRIMARY KEY,
          lid TEXT UNIQUE,
          phone_jid TEXT UNIQUE,
          phone_number TEXT,
          saved_name TEXT,
          whatsapp_name TEXT,
          avatar_token TEXT,
          avatar_checked_at INTEGER,
          avatar_missing_until INTEGER,
          avatar_failures INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS contact_identity_aliases(
          alias_id TEXT PRIMARY KEY,
          identity_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(identity_id) REFERENCES contact_identities(identity_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS contact_identity_alias_identity_v7_idx ON contact_identity_aliases(identity_id);
        CREATE INDEX IF NOT EXISTS contact_identity_phone_v7_idx ON contact_identities(phone_number);
        CREATE INDEX IF NOT EXISTS contact_identity_names_v7_idx ON contact_identities(saved_name, whatsapp_name);
      `))
      this.rebuildCanonicalContacts()
      this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (7, ?)').run(Date.now())
    }
    if (version.version < 8) {
      this.#logger.info({ version: 8 }, 'applying database migration')
      this.transaction(() => this.db.exec(`
        ALTER TABLE attachments ADD COLUMN thumbnail_checked_at INTEGER;
        ALTER TABLE attachments ADD COLUMN thumbnail_missing_until INTEGER;
        ALTER TABLE attachments ADD COLUMN thumbnail_failures INTEGER NOT NULL DEFAULT 0;
        UPDATE contact_identities SET
          avatar_checked_at=CASE WHEN avatar_token IS NULL THEN NULL ELSE avatar_checked_at END,
          avatar_missing_until=NULL,
          avatar_failures=0;
        INSERT INTO schema_migrations(version, applied_at) VALUES
          (8, CAST(strftime('%s','now') AS INTEGER) * 1000);
      `))
    }
    if (version.version < 9) {
      this.#logger.info({ version: 9 }, 'applying CRM database migration')
      const now = Date.now()
      const activeCutoff = now - 90 * 24 * 60 * 60 * 1000
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS crm_pipeline_stages(
            id TEXT PRIMARY KEY,
            key TEXT NOT NULL UNIQUE CHECK(key IN ('new','qualified','quoted','won','lost')),
            name TEXT NOT NULL,
            color TEXT NOT NULL,
            position INTEGER NOT NULL,
            outcome TEXT NOT NULL CHECK(outcome IN ('open','won','lost'))
          );
          INSERT OR IGNORE INTO crm_pipeline_stages(id, key, name, color, position, outcome) VALUES
            ('stage-new', 'new', 'New enquiry', '#F59E0B', 0, 'open'),
            ('stage-qualified', 'qualified', 'Qualified', '#EAB308', 1, 'open'),
            ('stage-quoted', 'quoted', 'Quoted', '#8B5CF6', 2, 'open'),
            ('stage-won', 'won', 'Won', '#84CC16', 3, 'won'),
            ('stage-lost', 'lost', 'Lost', '#EF4444', 4, 'lost');

          CREATE TABLE IF NOT EXISTS crm_contacts(
            id TEXT PRIMARY KEY,
            identity_id TEXT NOT NULL UNIQUE,
            chat_id TEXT NOT NULL,
            lifecycle TEXT NOT NULL DEFAULT 'lead' CHECK(lifecycle IN ('lead','customer','ignored','spam')),
            stage_id TEXT NOT NULL DEFAULT 'stage-new',
            name TEXT,
            email TEXT,
            company TEXT,
            address TEXT,
            birthday TEXT,
            tax_id TEXT,
            preferences TEXT,
            source TEXT NOT NULL DEFAULT 'whatsapp',
            consent_status TEXT NOT NULL DEFAULT 'unknown' CHECK(consent_status IN ('unknown','granted','denied')),
            do_not_contact INTEGER NOT NULL DEFAULT 0,
            custom_fields TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL,
            last_activity_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY(stage_id) REFERENCES crm_pipeline_stages(id)
          );
          CREATE INDEX IF NOT EXISTS crm_contacts_pipeline_v9_idx ON crm_contacts(lifecycle, stage_id, last_activity_at DESC);
          CREATE INDEX IF NOT EXISTS crm_contacts_chat_v9_idx ON crm_contacts(chat_id);

          CREATE TABLE IF NOT EXISTS crm_tags(
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            color TEXT NOT NULL DEFAULT '#64748b',
            created_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS crm_contact_tags(
            contact_id TEXT NOT NULL,
            tag_id TEXT NOT NULL,
            PRIMARY KEY(contact_id, tag_id),
            FOREIGN KEY(contact_id) REFERENCES crm_contacts(id) ON DELETE CASCADE,
            FOREIGN KEY(tag_id) REFERENCES crm_tags(id) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS crm_notes(
            id TEXT PRIMARY KEY,
            contact_id TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY(contact_id) REFERENCES crm_contacts(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS crm_notes_contact_v9_idx ON crm_notes(contact_id, created_at DESC);

          CREATE TABLE IF NOT EXISTS crm_catalog_items(
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL CHECK(type IN ('product','service')),
            name TEXT NOT NULL,
            sku TEXT,
            description TEXT,
            unit_price REAL NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'INR',
            active INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS crm_catalog_name_v9_idx ON crm_catalog_items(active, name COLLATE NOCASE);

          CREATE TABLE IF NOT EXISTS crm_orders(
            id TEXT PRIMARY KEY,
            contact_id TEXT NOT NULL,
            order_number TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL CHECK(status IN ('draft','confirmed','in-progress','completed','cancelled')),
            payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','partial','paid','refunded')),
            currency TEXT NOT NULL DEFAULT 'INR',
            subtotal REAL NOT NULL DEFAULT 0,
            discount REAL NOT NULL DEFAULT 0,
            tax REAL NOT NULL DEFAULT 0,
            total REAL NOT NULL DEFAULT 0,
            shipping_address TEXT,
            appointment_at INTEGER,
            expected_at INTEGER,
            customer_note TEXT,
            internal_note TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            completed_at INTEGER,
            FOREIGN KEY(contact_id) REFERENCES crm_contacts(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS crm_orders_contact_v9_idx ON crm_orders(contact_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS crm_orders_status_v9_idx ON crm_orders(status, updated_at DESC);
          CREATE TABLE IF NOT EXISTS crm_order_items(
            id TEXT PRIMARY KEY,
            order_id TEXT NOT NULL,
            catalog_item_id TEXT,
            type TEXT NOT NULL CHECK(type IN ('product','service')),
            name TEXT NOT NULL,
            sku TEXT,
            quantity REAL NOT NULL,
            unit_price REAL NOT NULL,
            discount REAL NOT NULL DEFAULT 0,
            tax_rate REAL NOT NULL DEFAULT 0,
            line_total REAL NOT NULL,
            position INTEGER NOT NULL,
            FOREIGN KEY(order_id) REFERENCES crm_orders(id) ON DELETE CASCADE,
            FOREIGN KEY(catalog_item_id) REFERENCES crm_catalog_items(id) ON DELETE SET NULL
          );
          CREATE TABLE IF NOT EXISTS crm_payments(
            id TEXT PRIMARY KEY,
            order_id TEXT NOT NULL,
            amount REAL NOT NULL,
            method TEXT,
            reference TEXT,
            paid_at INTEGER NOT NULL,
            note TEXT,
            FOREIGN KEY(order_id) REFERENCES crm_orders(id) ON DELETE CASCADE
          );

          CREATE TABLE IF NOT EXISTS crm_tasks(
            id TEXT PRIMARY KEY,
            contact_id TEXT NOT NULL,
            order_id TEXT,
            title TEXT NOT NULL,
            description TEXT,
            due_at INTEGER,
            priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high')),
            status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed','cancelled')),
            reminder_at INTEGER,
            notified_at INTEGER,
            created_at INTEGER NOT NULL,
            completed_at INTEGER,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY(contact_id) REFERENCES crm_contacts(id) ON DELETE CASCADE,
            FOREIGN KEY(order_id) REFERENCES crm_orders(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS crm_tasks_due_v9_idx ON crm_tasks(status, due_at, reminder_at);

          CREATE TABLE IF NOT EXISTS crm_activity(
            id TEXT PRIMARY KEY,
            contact_id TEXT NOT NULL,
            type TEXT NOT NULL,
            summary TEXT NOT NULL,
            metadata TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(contact_id) REFERENCES crm_contacts(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS crm_activity_contact_v9_idx ON crm_activity(contact_id, created_at DESC);
          CREATE TABLE IF NOT EXISTS google_contact_links(
            contact_id TEXT PRIMARY KEY,
            resource_name TEXT NOT NULL,
            etag TEXT,
            account_email TEXT,
            last_synced_at INTEGER NOT NULL,
            FOREIGN KEY(contact_id) REFERENCES crm_contacts(id) ON DELETE CASCADE
          );
        `)
        this.db.prepare(`
          INSERT OR IGNORE INTO crm_contacts(
            id, identity_id, chat_id, lifecycle, stage_id, name, source, created_at, last_activity_at, updated_at
          )
          SELECT lower(hex(randomblob(16))), identity.identity_id, chats.id, 'lead', 'stage-new',
            COALESCE(identity.whatsapp_name, identity.phone_number, NULLIF(chats.title, 'WhatsApp contact')),
            'whatsapp-backfill', MIN(inbound.timestamp), MAX(messages.timestamp), ?
          FROM chats
          JOIN contact_identity_aliases identity_alias ON identity_alias.alias_id=chats.id
          JOIN contact_identities identity ON identity.identity_id=identity_alias.identity_id
          JOIN messages inbound ON inbound.chat_id=chats.id AND inbound.from_me=0 AND inbound.timestamp>=?
          JOIN messages ON messages.chat_id=chats.id
          WHERE chats.kind='direct' AND identity.saved_name IS NULL
          GROUP BY identity.identity_id, chats.id
        `).run(now, activeCutoff)
        this.db.prepare(`
          INSERT INTO crm_activity(id, contact_id, type, summary, created_at)
          SELECT lower(hex(randomblob(16))), id, 'lead-created', 'Imported from recent WhatsApp enquiries', created_at
          FROM crm_contacts WHERE source='whatsapp-backfill'
        `).run()
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (9, ?)').run(now)
      })
    }
    if (version.version < 10) {
      this.#logger.info({ version: 10 }, 'applying CRM message-reference migration')
      this.transaction(() => this.db.exec(`
        ALTER TABLE crm_notes ADD COLUMN source_message_id TEXT;
        ALTER TABLE crm_notes ADD COLUMN source_message_snapshot TEXT;
        ALTER TABLE crm_tasks ADD COLUMN source_message_id TEXT;
        ALTER TABLE crm_tasks ADD COLUMN source_message_snapshot TEXT;
        CREATE INDEX IF NOT EXISTS crm_tasks_contact_status_due_v10_idx
          ON crm_tasks(contact_id, status, due_at, created_at);
        INSERT INTO schema_migrations(version, applied_at) VALUES
          (10, CAST(strftime('%s','now') AS INTEGER) * 1000);
      `))
    }
    if (version.version < 11) {
      this.#logger.info({ version: 11 }, 'retiring Google Contacts authorization data')
      this.transaction(() => this.db.exec(`
        DELETE FROM auth_store WHERE category='google';
        DELETE FROM crm_activity WHERE type='google-saved';
        DROP TABLE IF EXISTS google_contact_links;
        INSERT INTO schema_migrations(version, applied_at) VALUES
          (11, CAST(strftime('%s','now') AS INTEGER) * 1000);
      `))
    }
    if (version.version < 12) {
      this.#logger.info({ version: 12 }, 'updating CRM pipeline colors')
      this.transaction(() => this.db.exec(`
        UPDATE crm_pipeline_stages SET color=CASE id
          WHEN 'stage-new' THEN '#F59E0B'
          WHEN 'stage-qualified' THEN '#EAB308'
          WHEN 'stage-quoted' THEN '#8B5CF6'
          WHEN 'stage-won' THEN '#84CC16'
          WHEN 'stage-lost' THEN '#EF4444'
          ELSE color
        END
        WHERE id IN ('stage-new', 'stage-qualified', 'stage-quoted', 'stage-won', 'stage-lost');
        INSERT INTO schema_migrations(version, applied_at) VALUES
          (12, CAST(strftime('%s','now') AS INTEGER) * 1000);
      `))
    }
  }
}

function mapChat(row: Record<string, unknown>): ChatSummary {
  const id = String(row.id)
  const kind = row.kind as ChatSummary['kind']
  const savedName = validContactName(nullableString(row.contact_saved_name))
  const whatsappName = validContactName(nullableString(row.contact_whatsapp_name))
  const phoneNumber = kind === 'direct'
    ? formatPhoneNumber(normalizePhoneNumber(nullableString(row.contact_phone_number)) ?? phoneNumberFromJid(id))
    : undefined
  const storedTitle = kind === 'direct'
    ? validContactName(nullableString(row.title))
    : validIdentity(nullableString(row.title))
  const avatarToken = nullableString(row.contact_avatar_token)
  const storedAvatar = nullableString(row.avatar_url)
  const avatarUrl = avatarToken ? `warish-media://avatars/${encodeURIComponent(avatarToken)}`
    : storedAvatar?.startsWith('warish-media://') ? storedAvatar : undefined
  const distinctStoredTitle = storedTitle && storedTitle !== whatsappName ? storedTitle : undefined
  const title = kind === 'direct'
    ? savedName ?? phoneNumber ?? distinctStoredTitle ?? 'Unknown contact'
    : storedTitle ?? chatKindLabel(kind)
  const crmContactId = nullableString(row.crm_contact_id)
  const crm = crmContactId ? {
    contactId: crmContactId,
    name: nullableString(row.crm_name),
    lifecycle: row.crm_lifecycle as NonNullable<ChatSummary['crm']>['lifecycle'],
    stageId: String(row.crm_stage_id),
    stageKey: row.crm_stage_key as NonNullable<ChatSummary['crm']>['stageKey'],
    stageName: String(row.crm_stage_name),
    stageColor: String(row.crm_stage_color),
    openTaskCount: Number(row.crm_open_task_count ?? 0),
    nextTask: nullableString(row.crm_next_task_id) ? {
      id: String(row.crm_next_task_id), title: String(row.crm_next_task_title),
      dueAt: nullableNumber(row.crm_next_task_due_at),
      priority: row.crm_next_task_priority as NonNullable<NonNullable<ChatSummary['crm']>['nextTask']>['priority']
    } : undefined,
    restricted: Boolean(row.crm_restricted)
  } satisfies NonNullable<ChatSummary['crm']> : undefined
  return { id, title, kind, savedName, whatsappName, phoneNumber,
    communityId: nullableString(row.community_id), isAnnouncement: Boolean(row.is_community_announcement),
    readOnly: kind === 'channel' || kind === 'community', description: nullableString(row.description),
    avatarUrl, lastMessage: nullableString(row.last_message), lastMessageAt: nullableNumber(row.last_message_at),
    lastMessageId: nullableString(row.last_message_id), lastMessageFromMe: nullableBoolean(row.last_message_from_me),
    lastMessageStatus: nullableString(row.last_message_status) as DeliveryState | undefined,
    unreadCount: Number(row.unread_count ?? 0),
    archived: Boolean(row.archived), pinned: Boolean(row.pinned), mutedUntil: nullableNumber(row.muted_until), crm }
}

function mapAttachment(row: Record<string, unknown>): AttachmentDto {
  return { id: String(row.id), messageId: String(row.message_id), kind: row.kind as AttachmentDto['kind'],
    fileName: nullableString(row.file_name), mimeType: nullableString(row.mime_type), size: nullableNumber(row.size),
    width: nullableNumber(row.width), height: nullableNumber(row.height), durationSeconds: nullableNumber(row.duration_seconds),
    thumbnailDataUrl: nullableString(row.thumbnail_data_url), cacheToken: nullableString(row.cache_token),
    draftToken: nullableString(row.draft_token),
    downloadState: row.download_state as AttachmentDto['downloadState'] }
}

function nullableString(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean'
    ? String(value)
    : undefined
}
function nullableNumber(value: unknown): number | undefined { return value === null || value === undefined ? undefined : Number(value) }
function nullableBoolean(value: unknown): boolean | undefined { return value === null || value === undefined ? undefined : Boolean(value) }
function parseRichMessage(value: unknown): RichMessageDto | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value) as RichMessageDto
    return parsed && typeof parsed === 'object' && typeof parsed.type === 'string' ? parsed : undefined
  } catch { return undefined }
}
function attachmentKindValue(value: unknown): DraftDto['attachmentKind'] {
  return value === 'image' || value === 'video' || value === 'document' || value === 'audio' || value === 'voice' || value === 'sticker'
    ? value
    : undefined
}
function sanitizeSettings(value: Partial<AppSettings>): AppSettings {
  const theme = value.theme === 'system' || value.theme === 'light' || value.theme === 'dark' || value.theme === 'black' || value.theme === 'salesforce-black'
    ? value.theme
    : DEFAULT_SETTINGS.theme
  const density = value.density === 'comfortable' || value.density === 'compact' || value.density === 'dense' || value.density === 'ultra-dense'
    ? value.density
    : DEFAULT_SETTINGS.density
  const cacheLimit = Number(value.cacheLimitBytes)
  const historyDays = Number(value.historySyncDays)
  const navigationMode = value.navigationMode === 'expanded' || value.navigationMode === 'collapsed' || value.navigationMode === 'auto'
    ? value.navigationMode
    : DEFAULT_SETTINGS.navigationMode
  const conversationBackground = value.conversationBackground === 'subtle' || value.conversationBackground === 'plain' || value.conversationBackground === 'grid'
    ? value.conversationBackground
    : DEFAULT_SETTINGS.conversationBackground
  return {
    theme,
    density,
    notificationPreview: typeof value.notificationPreview === 'boolean' ? value.notificationPreview : DEFAULT_SETTINGS.notificationPreview,
    enterToSend: typeof value.enterToSend === 'boolean' ? value.enterToSend : DEFAULT_SETTINGS.enterToSend,
    showChatPreviews: typeof value.showChatPreviews === 'boolean' ? value.showChatPreviews : DEFAULT_SETTINGS.showChatPreviews,
    reduceMotion: typeof value.reduceMotion === 'boolean' ? value.reduceMotion : DEFAULT_SETTINGS.reduceMotion,
    conversationBackground,
    cacheLimitBytes: Number.isFinite(cacheLimit)
      ? Math.min(100 * 1024 ** 3, Math.max(256 * 1024 ** 2, Math.floor(cacheLimit)))
      : DEFAULT_SETTINGS.cacheLimitBytes,
    launchAtLogin: typeof value.launchAtLogin === 'boolean' ? value.launchAtLogin : DEFAULT_SETTINGS.launchAtLogin,
    historySyncDays: Number.isFinite(historyDays)
      ? Math.min(3_650, Math.max(1, Math.floor(historyDays)))
      : DEFAULT_SETTINGS.historySyncDays,
    navigationMode
  }
}
function normalizeDirectJid(jid: string, server: 'lid' | 's.whatsapp.net'): string {
  const user = (jid.split('@')[0] ?? jid).split(':')[0] ?? jid
  return `${user}@${server}`
}
function normalizeContactAlias(jid: string): string {
  if (isLidIdentity(jid)) return normalizeDirectJid(jid, 'lid')
  if (isPhoneIdentity(jid)) return normalizeDirectJid(jid, 's.whatsapp.net')
  return jid
}
function isLidIdentity(jid: string): boolean { return jid.endsWith('@lid') || jid.endsWith('@hosted.lid') }
function isPhoneIdentity(jid: string): boolean { return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@hosted') }
function normalizePhoneNumber(value?: string): string | undefined {
  if (!value) return undefined
  const user = (value.split('@')[0] ?? value).split(':')[0] ?? value
  const digits = user.replace(/\D/g, '')
  return digits.length >= 7 && digits.length <= 15 ? digits : undefined
}
function phoneNumberFromJid(jid: string): string | undefined {
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@hosted') ? normalizePhoneNumber(jid) : undefined
}
function formatPhoneNumber(value?: string): string | undefined { return value ? `+${value.replace(/^\+/, '')}` : undefined }
function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}
function validIdentity(value?: string): string | undefined {
  // WhatsApp can prefix privacy-masked LID labels with a bidi/zero-width control
  // character. Strip those before validation so a value such as
  // "\u200E+91••••••78" cannot be promoted to a visible contact name.
  const identity = value?.normalize('NFKC').replace(/[\u200B-\u200D\u200E\u200F\u2060\uFEFF]/g, '').trim()
  if (!identity || ['Group', 'WhatsApp contact', 'Unknown contact', 'WhatsApp name unavailable', 'Phone number unavailable'].includes(identity)) return undefined
  if (/^\+?[\d\s().-]{7,}$/.test(identity)) return undefined
  if (isMaskedPhoneLabel(identity)) return undefined
  return identity
}
function validContactName(value?: string): string | undefined {
  const identity = validIdentity(value)
  if (!identity || /^\+?[\d\s().-]+$/.test(identity)) return undefined
  return identity
}
function isMaskedPhoneLabel(value: string): boolean {
  const digitCount = (value.match(/\d/g) ?? []).length
  const hasMask = /[•●○◦∙⋅·*…․‥‧_]/u.test(value) || /[-.]{2,}/u.test(value)
  const nonPhoneCharacters = value.replace(/[\d\s+().,/\-•●○◦∙⋅·*…․‥‧_]/gu, '')
  return digitCount >= 3 && hasMask && nonPhoneCharacters.length === 0
}
function chatKindForJid(jid: string): ChatSummary['kind'] {
  if (jid.endsWith('@newsletter')) return 'channel'
  if (jid.endsWith('@g.us')) return 'group'
  if (jid.endsWith('@broadcast')) return 'broadcast'
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid') || jid.endsWith('@hosted') || jid.endsWith('@hosted.lid')
    ? 'direct'
    : 'unknown'
}
function chatKindLabel(kind: ChatSummary['kind']): string {
  if (kind === 'community') return 'Community'
  if (kind === 'channel') return 'Channel'
  if (kind === 'group') return 'Group'
  return 'Conversation'
}
function jidToLabel(jid: string): string {
  const kind = chatKindForJid(jid)
  if (kind !== 'direct') return chatKindLabel(kind)
  return formatPhoneNumber(phoneNumberFromJid(jid)) ?? 'WhatsApp contact'
}
function attachmentPreview(kind: MessageKind): string {
  const labels: Partial<Record<MessageKind, string>> = { image: 'Photo', video: 'Video', document: 'Document', audio: 'Audio',
    voice: 'Voice message', sticker: 'Sticker', location: 'Location', contact: 'Contact', poll: 'Poll' }
  return labels[kind] ?? 'Message'
}
function encodeChatCursor(chat: ChatSummary): string {
  return Buffer.from(JSON.stringify([Number(chat.pinned), chat.lastMessageAt ?? 0, chat.id])).toString('base64url')
}
function decodeChatCursor(cursor?: string): { pinned: number; timestamp: number; id: string } {
  if (!cursor) return { pinned: 2, timestamp: Number.MAX_SAFE_INTEGER, id: '\uffff' }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [number, number, string]
    if ((parsed[0] !== 0 && parsed[0] !== 1) || !Number.isFinite(parsed[1]) || typeof parsed[2] !== 'string') throw new Error('Invalid cursor')
    return { pinned: parsed[0], timestamp: parsed[1], id: parsed[2] }
  } catch {
    return { pinned: 2, timestamp: Number.MAX_SAFE_INTEGER, id: '\uffff' }
  }
}
function encodeCommunityCursor(timestamp: number, id: string): string {
  return Buffer.from(JSON.stringify([timestamp, id])).toString('base64url')
}
function decodeCommunityCursor(cursor?: string): { timestamp: number; id: string } {
  if (!cursor) return { timestamp: Number.MAX_SAFE_INTEGER, id: '\uffff' }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [number, string]
    if (!Number.isFinite(parsed[0]) || typeof parsed[1] !== 'string') throw new Error('Invalid cursor')
    return { timestamp: parsed[0], id: parsed[1] }
  } catch {
    return { timestamp: Number.MAX_SAFE_INTEGER, id: '\uffff' }
  }
}
function encodeMessageCursor(timestamp: number, id: string): string { return Buffer.from(JSON.stringify([timestamp, id])).toString('base64url') }
function decodeMessageCursor(cursor?: string): { timestamp: number; id: string } {
  if (!cursor) return { timestamp: Number.MAX_SAFE_INTEGER, id: '\uffff' }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [number, string]
    if (!Number.isFinite(parsed[0]) || typeof parsed[1] !== 'string') throw new Error('Invalid cursor')
    return { timestamp: parsed[0], id: parsed[1] }
  }
  catch { return { timestamp: Number.MAX_SAFE_INTEGER, id: '\uffff' } }
}
