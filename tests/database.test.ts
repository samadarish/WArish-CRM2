import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { WarishDatabase } from '../src/core/database'
import { CrmRepository } from '../src/core/crm-repository'
import { createPersistentAuthState, mergeAuthCreds } from '../src/core/auth-store'
import { DEFAULT_SETTINGS } from '../src/shared/contracts'

const directories: string[] = []

function createDatabase(): { database: WarishDatabase; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'warish-test-'))
  directories.push(directory)
  return {
    database: new WarishDatabase(join(directory, 'warish.sqlite'), Buffer.alloc(32, 7), pino({ enabled: false })),
    directory
  }
}

function dropCrmV9Schema(database: DatabaseSync): void {
  database.exec(`
    DROP TABLE IF EXISTS google_contact_links;
    DROP TABLE IF EXISTS crm_activity;
    DROP TABLE IF EXISTS crm_payments;
    DROP TABLE IF EXISTS crm_order_items;
    DROP TABLE IF EXISTS crm_tasks;
    DROP TABLE IF EXISTS crm_orders;
    DROP TABLE IF EXISTS crm_notes;
    DROP TABLE IF EXISTS crm_contact_tags;
    DROP TABLE IF EXISTS crm_tags;
    DROP TABLE IF EXISTS crm_catalog_items;
    DROP TABLE IF EXISTS crm_contacts;
    DROP TABLE IF EXISTS crm_pipeline_stages;
  `)
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('WarishDatabase', () => {
  it('migrates populated v6 contact rows into the canonical v7 identity index', () => {
    const { database, directory } = createDatabase()
    const path = join(directory, 'warish.sqlite')
    const phoneJid = '33612345678@s.whatsapp.net'
    const lid = '80345678901234@lid'
    database.upsertContact({ id: phoneJid, lid, phoneNumber: '33612345678', name: 'Migrated name', pushName: 'Migrated profile' })
    database.upsertChat({ id: lid, title: '+80••••34', kind: 'direct' })
    database.storeMessage({ id: 'migration-message', chatId: lid, fromMe: false, kind: 'text', text: 'Before migration',
      timestamp: 900, status: 'read', incrementUnread: false })
    database.close()

    const legacy = new DatabaseSync(path)
    dropCrmV9Schema(legacy)
    legacy.exec(`
      DROP TABLE contact_identity_aliases;
      DROP TABLE contact_identities;
      ALTER TABLE attachments DROP COLUMN thumbnail_checked_at;
      ALTER TABLE attachments DROP COLUMN thumbnail_missing_until;
      ALTER TABLE attachments DROP COLUMN thumbnail_failures;
      DELETE FROM schema_migrations WHERE version>=7;
    `)
    legacy.close()

    const migrated = new WarishDatabase(path, Buffer.alloc(32, 7), pino({ enabled: false }))
    expect(migrated.getChat(lid)).toMatchObject({ title: 'Migrated name', savedName: 'Migrated name',
      whatsappName: 'Migrated profile', phoneNumber: '+33612345678' })
    expect((migrated.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version).toBe(12)
    migrated.close()
  })

  it('migrates avatar suppression and media thumbnail retry state to v8', () => {
    const { database, directory } = createDatabase()
    const path = join(directory, 'warish.sqlite')
    const jid = '15550003333@s.whatsapp.net'
    database.upsertContact({ id: jid, phoneNumber: '15550003333' })
    database.storeMessage({ id: 'thumbnail-migration', chatId: jid, fromMe: false, kind: 'image', timestamp: 1_000,
      status: 'read', incrementUnread: false, attachment: {
        id: 'attachment:thumbnail-migration', kind: 'image', width: 1200, height: 800, downloadState: 'remote'
      } })
    database.markContactAvatarMissing(jid)
    database.close()

    const legacy = new DatabaseSync(path)
    dropCrmV9Schema(legacy)
    legacy.exec(`
      ALTER TABLE attachments DROP COLUMN thumbnail_checked_at;
      ALTER TABLE attachments DROP COLUMN thumbnail_missing_until;
      ALTER TABLE attachments DROP COLUMN thumbnail_failures;
      DELETE FROM schema_migrations WHERE version>=8;
    `)
    legacy.close()

    const migrated = new WarishDatabase(path, Buffer.alloc(32, 7), pino({ enabled: false }))
    expect(migrated.shouldRefreshContactAvatar(jid)).toBe(true)
    expect(migrated.shouldFetchMediaThumbnail('thumbnail-migration')).toBe(true)
    const columns = migrated.db.prepare("SELECT name FROM pragma_table_info('attachments')").all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'thumbnail_checked_at', 'thumbnail_missing_until', 'thumbnail_failures'
    ]))
    migrated.close()
  })

  it('migrates CRM notes and tasks to immutable message references in v10', () => {
    const { database, directory } = createDatabase()
    const path = join(directory, 'warish.sqlite')
    database.close()

    const legacy = new DatabaseSync(path)
    legacy.exec(`
      DROP INDEX crm_tasks_contact_status_due_v10_idx;
      ALTER TABLE crm_notes DROP COLUMN source_message_snapshot;
      ALTER TABLE crm_notes DROP COLUMN source_message_id;
      ALTER TABLE crm_tasks DROP COLUMN source_message_snapshot;
      ALTER TABLE crm_tasks DROP COLUMN source_message_id;
      DELETE FROM schema_migrations WHERE version>=10;
    `)
    legacy.close()

    const migrated = new WarishDatabase(path, Buffer.alloc(32, 7), pino({ enabled: false }))
    const noteColumns = migrated.db.prepare("SELECT name FROM pragma_table_info('crm_notes')").all() as Array<{ name: string }>
    const taskColumns = migrated.db.prepare("SELECT name FROM pragma_table_info('crm_tasks')").all() as Array<{ name: string }>
    const taskIndexes = migrated.db.prepare("SELECT name FROM pragma_index_list('crm_tasks')").all() as Array<{ name: string }>
    expect(noteColumns.map((column) => column.name)).toEqual(expect.arrayContaining(['source_message_id', 'source_message_snapshot']))
    expect(taskColumns.map((column) => column.name)).toEqual(expect.arrayContaining(['source_message_id', 'source_message_snapshot']))
    expect(taskIndexes.map((index) => index.name)).toContain('crm_tasks_contact_status_due_v10_idx')
    migrated.close()
  })

  it('purges retired Google credentials, links, and activity in v11', () => {
    const { database, directory } = createDatabase()
    const path = join(directory, 'warish.sqlite')
    const chatId = '15550001111@s.whatsapp.net'
    database.upsertContact({ id: chatId, phoneNumber: '15550001111', pushName: 'Migration Contact' })
    database.upsertChat({ id: chatId, title: 'Migration Contact', kind: 'direct' })
    const contact = new CrmRepository(database, () => undefined).ensureContact(chatId)
    database.close()

    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE google_contact_links(contact_id TEXT PRIMARY KEY, resource_name TEXT NOT NULL);
      INSERT INTO google_contact_links(contact_id, resource_name) VALUES ('${contact.id}', 'people/old');
      INSERT INTO auth_store(account_id, category, key_id, value, updated_at)
        VALUES ('primary', 'google', 'oauth', X'01', 1), ('primary', 'baileys-test', 'marker', X'02', 1);
      INSERT INTO crm_activity(id, contact_id, type, summary, created_at)
        VALUES ('google-activity', '${contact.id}', 'google-saved', 'Saved to Google Contacts', 1),
               ('kept-activity', '${contact.id}', 'note-added', 'Keep this activity', 2);
      DELETE FROM schema_migrations WHERE version>=11;
    `)
    legacy.close()

    const migrated = new WarishDatabase(path, Buffer.alloc(32, 7), pino({ enabled: false }))
    const categories = migrated.db.prepare('SELECT category FROM auth_store ORDER BY category').all() as Array<{ category: string }>
    const activityTypes = migrated.db.prepare('SELECT type FROM crm_activity ORDER BY type').all() as Array<{ type: string }>
    const retiredTable = migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='google_contact_links'").get()
    expect(categories.map((row) => row.category)).toEqual(['baileys-test'])
    expect(activityTypes.map((row) => row.type)).toEqual(expect.arrayContaining(['lead-created', 'note-added']))
    expect(activityTypes.map((row) => row.type)).not.toContain('google-saved')
    expect(retiredTable).toBeUndefined()
    expect((migrated.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version).toBe(12)
    migrated.close()
  })

  it('standardizes CRM pipeline colors in v12', () => {
    const { database, directory } = createDatabase()
    const path = join(directory, 'warish.sqlite')
    database.close()

    const legacy = new DatabaseSync(path)
    legacy.exec(`
      UPDATE crm_pipeline_stages SET color=CASE id
        WHEN 'stage-new' THEN '#0ea5a4'
        WHEN 'stage-qualified' THEN '#3b82f6'
        WHEN 'stage-quoted' THEN '#8b5cf6'
        WHEN 'stage-won' THEN '#16a34a'
        WHEN 'stage-lost' THEN '#64748b'
        ELSE color
      END;
      DELETE FROM schema_migrations WHERE version>=12;
    `)
    legacy.close()

    const migrated = new WarishDatabase(path, Buffer.alloc(32, 7), pino({ enabled: false }))
    const colors = migrated.db.prepare('SELECT id, color FROM crm_pipeline_stages ORDER BY position').all() as Array<{ id: string; color: string }>
    expect(Object.fromEntries(colors.map((stage) => [stage.id, stage.color]))).toEqual({
      'stage-new': '#F59E0B',
      'stage-qualified': '#EAB308',
      'stage-quoted': '#8B5CF6',
      'stage-won': '#84CC16',
      'stage-lost': '#EF4444'
    })
    expect((migrated.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version).toBe(12)
    migrated.close()
  })

  it('stores encrypted auth state and isolates its context', () => {
    const { database } = createDatabase()
    database.setAuth('creds', 'primary', Buffer.from('registered session'))

    expect(database.getAuth('creds', 'primary')?.toString()).toBe('registered session')
    const raw = database.db.prepare('SELECT value FROM auth_store').get() as { value: Uint8Array }
    expect(Buffer.from(raw.value).toString()).not.toContain('registered session')
    database.close()
  })

  it('resets only the contact app-state checkpoint for a safe full refresh', () => {
    const { database } = createDatabase()
    const auth = createPersistentAuthState(database)
    auth.state.creds.registered = true
    auth.saveCreds()
    const storedCredentials = database.getAuth('creds', 'primary')
    database.setAuth('app-state-sync-key', 'contact-key', Buffer.from('key material'))
    database.setAuth('app-state-sync-version', 'critical_unblock_low', Buffer.from('contact checkpoint'))
    database.setAuth('app-state-sync-version', 'regular', Buffer.from('regular checkpoint'))

    auth.resetAppStateSyncVersion('critical_unblock_low')

    expect(database.getAuth('app-state-sync-version', 'critical_unblock_low')).toBeUndefined()
    expect(database.getAuth('app-state-sync-version', 'regular')?.toString()).toBe('regular checkpoint')
    expect(database.getAuth('app-state-sync-key', 'contact-key')?.toString()).toBe('key material')
    expect(database.getAuth('creds', 'primary')).toEqual(storedCredentials)
    database.close()
  })

  it('restores registered credentials and the local account marker across a restart', () => {
    const { database, directory } = createDatabase()
    const auth = createPersistentAuthState(database)
    auth.state.creds.registered = true
    auth.saveCreds()
    database.setAccount('15550001111', 'Restart test')
    expect(database.hasLinkedAccount()).toBe(true)
    database.close()

    const reopened = new WarishDatabase(join(directory, 'warish.sqlite'), Buffer.alloc(32, 7), pino({ enabled: false }))
    expect(createPersistentAuthState(reopened).state.creds.registered).toBe(true)
    expect(reopened.hasLinkedAccount()).toBe(true)
    reopened.close()
  })

  it('repairs a completed QR session persisted without the Baileys registered flag', () => {
    const { database, directory } = createDatabase()
    const auth = createPersistentAuthState(database)
    auth.state.creds.me = { id: '15550001111:1@s.whatsapp.net', name: 'Restart test' }
    auth.state.creds.account = {}
    auth.state.creds.registered = false
    auth.saveCreds()
    database.close()

    const reopened = new WarishDatabase(join(directory, 'warish.sqlite'), Buffer.alloc(32, 7), pino({ enabled: false }))
    const recovered = createPersistentAuthState(reopened)
    expect(recovered.state.creds.registered).toBe(true)
    expect(reopened.getAuth('creds', 'primary')?.toString()).toContain('"registered":true')
    reopened.close()
  })

  it('does not treat an unfinished phone-number pairing identity as linked', () => {
    const { database, directory } = createDatabase()
    const auth = createPersistentAuthState(database)
    auth.state.creds.me = { id: '15550001111@s.whatsapp.net', name: '~' }
    auth.state.creds.registered = false
    auth.saveCreds()
    database.close()

    const reopened = new WarishDatabase(join(directory, 'warish.sqlite'), Buffer.alloc(32, 7), pino({ enabled: false }))
    expect(createPersistentAuthState(reopened).state.creds.registered).toBe(false)
    reopened.close()
  })

  it('marks a pair-success credential update as registered before persistence', () => {
    const { database } = createDatabase()
    const auth = createPersistentAuthState(database)
    const repaired = mergeAuthCreds(auth.state.creds, {
      me: { id: '15550001111:1@s.whatsapp.net', name: 'Pair success' },
      account: {}
    })
    auth.saveCreds()

    expect(repaired).toBe(true)
    expect(auth.state.creds.registered).toBe(true)
    expect(database.getAuth('creds', 'primary')?.toString()).toContain('"registered":true')
    database.close()
  })

  it('creates a chat before its first message and increments unread only once', () => {
    const { database } = createDatabase()
    const message = { id: 'message-1', chatId: '15550001111@s.whatsapp.net', fromMe: false,
      kind: 'text' as const, text: 'hello from WhatsApp', timestamp: 1_720_000_000_000, status: 'delivered' as const }

    database.upsertMessage(message)
    database.upsertMessage(message)

    expect(database.getChat(message.chatId).unreadCount).toBe(1)
    expect(database.listMessages(message.chatId).items).toHaveLength(1)
    expect(database.searchMessages('hello').items[0]?.id).toBe(message.id)
    database.close()
  })

  it('preserves user chat flags during later message updates', () => {
    const { database } = createDatabase()
    const chatId = '15550002222@s.whatsapp.net'
    database.upsertChat({ id: chatId, title: 'Example', kind: 'direct', archived: true, pinned: true })
    database.upsertMessage({ id: 'message-2', chatId, fromMe: true, kind: 'text', text: 'sent', timestamp: Date.now(), status: 'sent' })

    expect(database.getChat(chatId)).toMatchObject({ title: '+15550002222', archived: true, pinned: true })
    database.close()
  })

  it('does not count imported history as new unread messages', () => {
    const { database } = createDatabase()
    const chatId = '15550003333@s.whatsapp.net'
    database.upsertChat({ id: chatId, title: 'History', kind: 'direct', unreadCount: 2 })
    database.upsertMessage({ id: 'historic-message', chatId, fromMe: false, kind: 'text', text: 'old',
      timestamp: Date.now() - 100_000, status: 'delivered', incrementUnread: false })

    expect(database.getChat(chatId).unreadCount).toBe(2)
    database.close()
  })

  it('does not reset unrelated settings when one value changes', () => {
    const { database } = createDatabase()
    database.updateSettings({ notificationPreview: false })
    database.updateSettings({ theme: 'salesforce-black', density: 'dense', navigationMode: 'expanded', notificationPreview: undefined })

    expect(database.getSettings()).toMatchObject({ theme: 'salesforce-black', density: 'dense', navigationMode: 'expanded', notificationPreview: false })
    database.close()
  })

  it('uses dense defaults and fills new preferences in older settings records', () => {
    const { database } = createDatabase()
    expect(database.getSettings()).toMatchObject({
      density: 'dense', enterToSend: true, showChatPreviews: true, reduceMotion: false, conversationBackground: 'subtle'
    })

    database.db.prepare("INSERT INTO settings(key, value, updated_at) VALUES ('application', ?, ?)")
      .run(JSON.stringify({ theme: 'dark', density: 'comfortable', notificationPreview: false }), Date.now())

    expect(database.getSettings()).toMatchObject({
      theme: 'dark', density: 'comfortable', notificationPreview: false,
      enterToSend: DEFAULT_SETTINGS.enterToSend,
      showChatPreviews: DEFAULT_SETTINGS.showChatPreviews,
      reduceMotion: DEFAULT_SETTINGS.reduceMotion,
      conversationBackground: DEFAULT_SETTINGS.conversationBackground
    })
    database.close()
  })

  it('persists the messaging and workspace appearance preferences together', () => {
    const { database } = createDatabase()
    database.updateSettings({ density: 'ultra-dense', enterToSend: false, showChatPreviews: false,
      reduceMotion: true, conversationBackground: 'grid' })

    expect(database.getSettings()).toMatchObject({
      density: 'ultra-dense', enterToSend: false, showChatPreviews: false, reduceMotion: true, conversationBackground: 'grid'
    })
    database.close()
  })

  it('can explicitly prune messages outside a history window', () => {
    const { database } = createDatabase()
    const chatId = '15550004444@s.whatsapp.net'
    database.upsertMessage({ id: 'old', chatId, fromMe: false, kind: 'text', text: 'too old',
      timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000, status: 'delivered' })
    database.upsertMessage({ id: 'recent', chatId, fromMe: false, kind: 'text', text: 'keep me',
      timestamp: Date.now() - 60_000, status: 'delivered' })

    database.pruneMessagesBefore(Date.now() - 24 * 60 * 60 * 1000)

    expect(database.listMessages(chatId).items.map((message) => message.id)).toEqual(['recent'])
    expect(database.getChat(chatId).lastMessage).toBe('keep me')
    database.close()
  })

  it('retains explicitly loaded older messages and exposes the oldest WhatsApp anchor', () => {
    const { database } = createDatabase()
    const chatId = '15550005555@s.whatsapp.net'
    database.updateSettings({ historySyncDays: 1 })
    database.storeMessage({ id: 'recent-anchor', chatId, fromMe: false, kind: 'text', text: 'recent',
      timestamp: Date.now() - 60_000, status: 'delivered', rawPayload: Buffer.from('recent raw') })
    database.storeMessage({ id: 'loaded-on-demand', chatId, fromMe: false, kind: 'text', text: 'older',
      timestamp: Date.now() - 10 * 24 * 60 * 60 * 1000, status: 'delivered', rawPayload: Buffer.from('older raw') })

    const anchor = database.getOldestMessageAnchor(chatId)
    expect(anchor).toMatchObject({ id: 'loaded-on-demand' })
    expect(anchor?.rawPayload.toString()).toBe('older raw')
    expect(database.listMessagesBefore(chatId, Date.now(), '\uffff', 50).items.map((message) => message.id))
      .toEqual(['loaded-on-demand', 'recent-anchor'])
    database.close()
  })

  it('falls back to the newest message page when a cursor has invalid tuple values', () => {
    const { database } = createDatabase()
    const chatId = '15550005556@s.whatsapp.net'
    database.storeMessage({ id: 'older', chatId, fromMe: false, kind: 'text', text: 'older',
      timestamp: 1_000, status: 'read', incrementUnread: false })
    database.storeMessage({ id: 'newer', chatId, fromMe: false, kind: 'text', text: 'newer',
      timestamp: 2_000, status: 'read', incrementUnread: false })
    const invalidCursor = Buffer.from(JSON.stringify(['not-a-timestamp', { id: 'not-a-string' }])).toString('base64url')

    expect(database.listMessages(chatId, invalidCursor, 1).items.map((message) => message.id)).toEqual(['newer'])
    database.close()
  })

  it('keeps the newest preview across out-of-order and equal-timestamp imports', () => {
    const { database } = createDatabase()
    const chatId = '15550006666@s.whatsapp.net'

    database.storeMessage({ id: 'middle', chatId, fromMe: false, kind: 'text', text: 'newest so far',
      timestamp: 2_000, status: 'delivered', incrementUnread: false })
    database.storeMessage({ id: 'older', chatId, fromMe: false, kind: 'text', text: 'must not replace preview',
      timestamp: 1_000, status: 'delivered', incrementUnread: false })
    database.storeMessage({ id: 'alpha', chatId, fromMe: false, kind: 'text', text: 'lower equal ID',
      timestamp: 2_000, status: 'delivered', incrementUnread: false })
    database.storeMessage({ id: 'zulu', chatId, fromMe: false, kind: 'text', text: 'stable equal-time winner',
      timestamp: 2_000, status: 'delivered', incrementUnread: false })
    database.storeMessage({ id: 'zulu', chatId, fromMe: false, kind: 'text', text: 'same message refreshed',
      timestamp: 2_000, status: 'delivered', incrementUnread: false })

    expect(database.getChat(chatId)).toMatchObject({ lastMessage: 'same message refreshed', lastMessageAt: 2_000 })
    database.close()
  })

  it('exposes and refreshes latest-message delivery metadata in every chat query', () => {
    const { database } = createDatabase()
    const chatId = '15550006667@s.whatsapp.net'

    database.storeMessage({ id: 'outgoing-latest', chatId, fromMe: true, kind: 'text', text: 'On its way',
      timestamp: 2_000, status: 'delivered', incrementUnread: false })
    const delivered = { lastMessageId: 'outgoing-latest', lastMessageFromMe: true, lastMessageStatus: 'delivered' }
    expect(database.getChat(chatId)).toMatchObject(delivered)
    expect(database.getChats([chatId])).toEqual([expect.objectContaining(delivered)])
    expect(database.listChats({}).items).toEqual([expect.objectContaining(delivered)])

    database.updateMessageStatus('outgoing-latest', 'read')
    const read = { ...delivered, lastMessageStatus: 'read' }
    expect(database.getChat(chatId)).toMatchObject(read)
    expect(database.getChats([chatId])).toEqual([expect.objectContaining(read)])
    expect(database.listChats({}).items).toEqual([expect.objectContaining(read)])

    database.storeMessage({ id: 'incoming-latest', chatId, fromMe: false, kind: 'text', text: 'Reply',
      timestamp: 3_000, status: 'read', incrementUnread: false })
    expect(database.getChat(chatId)).toMatchObject({
      lastMessageId: 'incoming-latest', lastMessageFromMe: false, lastMessageStatus: 'read'
    })
    database.close()
  })

  it('filters the complete chat query by exact CRM stage while preserving search and pagination', () => {
    const { database } = createDatabase()
    const crm = new CrmRepository(database, () => undefined)
    const stages = [
      ['15550100001@s.whatsapp.net', 'New Match', 'stage-new'],
      ['15550100002@s.whatsapp.net', 'Qualified Match', 'stage-qualified'],
      ['15550100003@s.whatsapp.net', 'Quoted Match', 'stage-quoted'],
      ['15550100004@s.whatsapp.net', 'Won Match A', 'stage-won'],
      ['15550100005@s.whatsapp.net', 'Won Other B', 'stage-won'],
      ['15550100006@s.whatsapp.net', 'Lost Match', 'stage-lost']
    ] as const
    for (const [index, [chatId, name, stageId]] of stages.entries()) {
      database.upsertContact({ id: chatId, phoneNumber: chatId.split('@')[0], name })
      database.storeMessage({ id: `stage-message-${index}`, chatId, fromMe: false, kind: 'text', text: name,
        timestamp: 10_000 + index, status: 'read', incrementUnread: false })
      const contact = crm.ensureContact(chatId)
      if (stageId !== 'stage-new') crm.setStage(contact.id, stageId)
    }
    const untrackedId = '15550100007@s.whatsapp.net'
    database.storeMessage({ id: 'untracked-message', chatId: untrackedId, fromMe: false, kind: 'text', text: 'Untracked Match',
      timestamp: 20_000, status: 'read', incrementUnread: false })

    const ids = (crmStage: 'all' | 'new' | 'won' | 'lost', query?: string) =>
      database.listChats({ category: 'direct', crmStage, query }).items.map((chat) => chat.id)
    expect(ids('new')).toEqual(['15550100001@s.whatsapp.net'])
    expect(ids('won')).toEqual(['15550100005@s.whatsapp.net', '15550100004@s.whatsapp.net'])
    expect(ids('lost')).toEqual(['15550100006@s.whatsapp.net'])
    expect(ids('all')).toEqual([untrackedId, ...stages.map(([chatId]) => chatId).reverse()])
    expect(ids('won', 'Match')).toEqual(['15550100004@s.whatsapp.net'])

    const firstWonPage = database.listChats({ category: 'direct', crmStage: 'won', limit: 1 })
    expect(firstWonPage.items.map((chat) => chat.id)).toEqual(['15550100005@s.whatsapp.net'])
    expect(firstWonPage.nextCursor).toBeDefined()
    expect(database.listChats({ category: 'direct', crmStage: 'won', limit: 1, cursor: firstWonPage.nextCursor })
      .items.map((chat) => chat.id)).toEqual(['15550100004@s.whatsapp.net'])
    database.close()
  })

  it('paginates pinned and unpinned chats without duplicates at equal timestamps', () => {
    const { database } = createDatabase()
    const expected = [
      ['pinned-z', true, 2_000], ['pinned-a', true, 2_000], ['pinned-old', true, 1_000],
      ['regular-z', false, 2_000], ['regular-a', false, 2_000], ['regular-old', false, 1_000]
    ] as const
    for (const [id, pinned, timestamp] of expected) {
      database.upsertChat({ id, title: id, kind: 'direct', pinned, lastMessage: id,
        lastMessageAt: timestamp, lastMessageId: `message-${id}` })
    }

    const ids: string[] = []
    let cursor: string | undefined
    do {
      const page = database.listChats({ cursor, limit: 2 })
      ids.push(...page.items.map((chat) => chat.id))
      cursor = page.nextCursor
    } while (cursor)

    expect(ids).toEqual(expected.map(([id]) => id))
    expect(new Set(ids).size).toBe(ids.length)
    database.close()
  })

  it('resolves saved and push names through phone-to-LID mappings', () => {
    const { database } = createDatabase()
    const phoneJid = '15550007777@s.whatsapp.net'
    const lid = '103948576120398@lid'
    database.upsertContact({ id: phoneJid, phoneNumber: '15550007777', name: 'Saved Contact', pushName: 'Push Name' })
    database.setAuth('lid-mapping', '15550007777', Buffer.from(JSON.stringify('103948576120398')))
    database.db.prepare("INSERT INTO sync_state(key, value, updated_at) VALUES ('identity_repair_v4', 'complete', ?)").run(Date.now())
    expect(database.needsIdentityRepair()).toBe(true)
    expect(database.recoverContactLidMappings()).toMatchObject({ mappings: 1 })
    database.completeIdentityRepair()
    expect(database.needsIdentityRepair()).toBe(false)
    database.upsertChat({ id: lid, title: '+103948576120398', kind: 'direct' })
    database.storeMessage({ id: 'named-chat-message', chatId: lid, fromMe: false, kind: 'text', text: 'Hello',
      timestamp: Date.now(), status: 'read', incrementUnread: false })

    expect(database.getChat(lid)).toMatchObject({ title: 'Saved Contact', savedName: 'Saved Contact',
      whatsappName: 'Push Name', phoneNumber: '+15550007777' })
    expect(database.listChats({ query: 'Saved Contact' }).items.map((chat) => chat.id)).toEqual([lid])

    database.upsertContact({ id: '15550008888@s.whatsapp.net', phoneNumber: '15550008888', pushName: 'WhatsApp Name' })
    database.upsertChat({ id: '15550008888@s.whatsapp.net', title: '+15550008888', kind: 'direct' })
    expect(database.getChat('15550008888@s.whatsapp.net')).toMatchObject({
      title: '+15550008888', whatsappName: 'WhatsApp Name', phoneNumber: '+15550008888'
    })
    database.close()
  })

  it('keeps saved names, WhatsApp profile names, and full numbers as separate identity fields', () => {
    const { database } = createDatabase()
    const savedJid = '447700900111@s.whatsapp.net'
    database.upsertContact({ id: savedJid, phoneNumber: '447700900111', name: 'A saved name', pushName: 'WhatsApp profile' })
    database.upsertChat({ id: savedJid, title: '+44••••111', kind: 'direct', lastMessage: 'Hello',
      lastMessageAt: 1_000, lastMessageId: 'saved-message' })

    expect(database.getChat(savedJid)).toMatchObject({
      title: 'A saved name', savedName: 'A saved name', whatsappName: 'WhatsApp profile', phoneNumber: '+447700900111'
    })

    const lid = '90123456789012@lid'
    database.upsertContact({ id: lid, lid, phoneNumber: '919876543210', pushName: 'Unsaved profile' })
    database.upsertChat({ id: lid, title: '+90………12', kind: 'direct', lastMessage: 'Hi',
      lastMessageAt: 2_000, lastMessageId: 'unsaved-message' })
    expect(database.getChat(lid)).toMatchObject({
      title: '+919876543210', whatsappName: 'Unsaved profile', phoneNumber: '+919876543210'
    })
    database.close()
  })

  it('continuously merges independently learned PN and LID identities into one canonical contact', () => {
    const { database } = createDatabase()
    const phoneJid = '447700901234@s.whatsapp.net'
    const lid = '83920174650123@lid'
    database.upsertContact({ id: phoneJid, phoneNumber: '447700901234', name: 'Saved on phone', pushName: 'WhatsApp profile' })
    database.upsertChat({ id: lid, title: '+83••••23', kind: 'direct' })
    database.storeMessage({ id: 'lid-only-message', chatId: lid, fromMe: false, kind: 'text', text: 'Hello',
      timestamp: 4_000, status: 'read', incrementUnread: false })

    expect(database.getChat(lid)).toMatchObject({ title: 'Unknown contact', savedName: undefined, phoneNumber: undefined })

    database.linkContactLid(lid, phoneJid)

    expect(database.getChat(lid)).toMatchObject({
      title: 'Saved on phone', savedName: 'Saved on phone', whatsappName: 'WhatsApp profile', phoneNumber: '+447700901234'
    })
    const identities = database.db.prepare(
      `SELECT COUNT(DISTINCT identity_id) AS count FROM contact_identity_aliases WHERE alias_id IN (?, ?)`
    ).get(lid, phoneJid) as { count: number }
    expect(identities.count).toBe(1)
    expect(database.identityCoverage()).toMatchObject({ directChats: 1, resolvedNames: 1, resolvedPhones: 1 })
    database.close()
  })

  it('rebuilds stale legacy contacts into direct-chat identities without touching messages', () => {
    const { database } = createDatabase()
    const lid = '65012349876543@lid'
    const phoneJid = '15550123456@s.whatsapp.net'
    database.upsertChat({ id: lid, title: 'WhatsApp contact', kind: 'direct' })
    database.storeMessage({ id: 'preserved-message', chatId: lid, fromMe: false, kind: 'text', text: 'Keep me',
      timestamp: 5_000, status: 'read', incrementUnread: false })
    database.db.prepare(
      `INSERT INTO contacts(id, account_id, jid, lid, phone_number, name, push_name, updated_at)
       VALUES (?, 'primary', ?, ?, ?, ?, ?, ?)`
    ).run(phoneJid, phoneJid, lid, '15550123456', 'Saved after sync', 'Profile after sync', Date.now())

    expect(database.getChat(lid)).toMatchObject({ savedName: undefined, whatsappName: undefined })
    expect(database.rebuildCanonicalContacts()).toMatchObject({ contacts: 1, directChats: 1 })
    expect(database.getChat(lid)).toMatchObject({ title: 'Saved after sync', savedName: 'Saved after sync',
      whatsappName: 'Profile after sync', phoneNumber: '+15550123456' })
    expect(database.getMessage('preserved-message').text).toBe('Keep me')
    expect(database.identityCoverage()).toMatchObject({ savedNames: 1, profileNames: 1 })
    database.close()
  })

  it('does not promote masked numbers or numeric placeholders into contact names', () => {
    const { database } = createDatabase()
    const lid = '72910834561234@lid'
    database.upsertContact({ id: lid, lid, name: '+91••••52', pushName: 'Phone number unavailable' })
    database.upsertChat({ id: lid, title: '+72………34', kind: 'direct' })
    database.storeMessage({ id: 'masked-contact-message', chatId: lid, fromMe: false, kind: 'text', text: 'Hello',
      timestamp: 5_000, status: 'read', incrementUnread: false })

    expect(database.getContactDetails(lid)).toMatchObject({ title: 'Unknown contact', savedName: undefined,
      whatsappName: undefined, phoneNumber: undefined })
    database.close()
  })

  it('uses the resolved full phone number when a direct-chat title is bidi-masked', () => {
    const { database } = createDatabase()
    const lid = '72910834561234@lid'
    database.upsertContact({ id: lid, lid, phoneNumber: '9194791368678' })
    database.upsertChat({ id: lid, title: '\u200E+91••••••78', kind: 'direct' })

    expect(database.getChat(lid)).toMatchObject({
      title: '+9194791368678', savedName: undefined, whatsappName: undefined, phoneNumber: '+9194791368678'
    })
    database.close()
  })

  it('exposes only local profile-image URLs and clears their diagnostic state with the cache', () => {
    const { database } = createDatabase()
    const jid = '15551239876@s.whatsapp.net'
    database.upsertContact({ id: jid, phoneNumber: '15551239876', pushName: 'Avatar Contact', avatarUrl: 'https://example.invalid/photo.jpg' })
    database.upsertChat({ id: jid, title: 'Avatar Contact', kind: 'direct' })
    database.storeMessage({ id: 'avatar-message', chatId: jid, fromMe: false, kind: 'text', text: 'Hello',
      timestamp: 6_000, status: 'read', incrementUnread: false })
    expect(database.getChat(jid).avatarUrl).toBeUndefined()

    database.saveContactAvatar(jid, 'avatar-local.jpg')
    expect(database.getChat(jid).avatarUrl).toBe('warish-media://avatars/avatar-local.jpg')
    expect(database.identityCoverage().cachedAvatars).toBe(1)
    expect(database.shouldRefreshContactAvatar(jid)).toBe(false)
    database.db.prepare('UPDATE contact_identities SET avatar_checked_at=?').run(Date.now() - 8 * 24 * 60 * 60 * 1000)
    expect(database.shouldRefreshContactAvatar(jid)).toBe(true)
    const retryStartedAt = Date.now()
    database.markContactAvatarFailure(jid)
    expect(database.getChat(jid).avatarUrl).toBe('warish-media://avatars/avatar-local.jpg')
    expect(database.shouldRefreshContactAvatar(jid, false, retryStartedAt)).toBe(false)
    expect(database.shouldRefreshContactAvatar(jid, false, retryStartedAt + 6 * 60 * 1000)).toBe(true)
    database.markContactAvatarMissing(jid)
    expect(database.shouldRefreshContactAvatar(jid)).toBe(false)
    expect(database.identityCoverage().cachedAvatars).toBe(0)
    database.clearContactAvatarTokens()
    expect(database.getChat(jid).avatarUrl).toBeUndefined()
    database.close()
  })

  it('caches media thumbnails and backs off missing previews without changing media dimensions', () => {
    const { database } = createDatabase()
    const jid = '15550004444@s.whatsapp.net'
    database.storeMessage({ id: 'thumbnail-message', chatId: jid, fromMe: false, kind: 'image', timestamp: 2_000,
      status: 'read', incrementUnread: false, attachment: {
        id: 'attachment:thumbnail-message', kind: 'image', width: 900, height: 1600, downloadState: 'remote'
      } })
    expect(database.shouldFetchMediaThumbnail('thumbnail-message')).toBe(true)

    const checkedAt = Date.now()
    database.markMediaThumbnailUnavailable('thumbnail-message', 5 * 60 * 1000)
    expect(database.shouldFetchMediaThumbnail('thumbnail-message', checkedAt)).toBe(false)
    expect(database.shouldFetchMediaThumbnail('thumbnail-message', checkedAt + 6 * 60 * 1000)).toBe(true)

    const thumbnail = 'data:image/jpeg;base64,/9j/2Q=='
    database.saveMediaThumbnail('thumbnail-message', thumbnail)
    expect(database.shouldFetchMediaThumbnail('thumbnail-message', checkedAt + 24 * 60 * 60 * 1000)).toBe(false)
    expect(database.getMessage('thumbnail-message').attachment).toMatchObject({
      thumbnailDataUrl: thumbnail, width: 900, height: 1600, downloadState: 'remote'
    })
    database.close()
  })

  it('keeps the indexed first chat page within the representative-data query budget', () => {
    const { database } = createDatabase()
    database.transaction(() => {
      for (let index = 0; index < 1_000; index += 1) {
        const phone = `1555${String(index).padStart(7, '0')}`
        const jid = `${phone}@s.whatsapp.net`
        database.upsertContact({ id: jid, phoneNumber: phone, name: `Contact ${index}` })
        database.storeMessage({ id: `perf-message-${String(index).padStart(4, '0')}`, chatId: jid, fromMe: false,
          kind: 'text', text: `Message ${index}`, timestamp: index, status: 'read', incrementUnread: false })
      }
    })
    const started = performance.now()
    const page = database.listChats({ limit: 80 })
    const duration = performance.now() - started

    expect(page.items).toHaveLength(80)
    expect(duration).toBeLessThan(50)
    database.close()
  })

  it('segregates direct chats, groups, communities, and read-only channels', () => {
    const { database } = createDatabase()
    const directId = '15550001001@s.whatsapp.net'
    const groupId = '10001@g.us'
    const communityId = '20001@g.us'
    const announcementId = '20002@g.us'
    const childId = '20003@g.us'
    const channelId = '30001@newsletter'
    database.storeMessage({ id: 'direct-message', chatId: directId, fromMe: false, kind: 'text', text: 'Direct',
      timestamp: 1_000, status: 'read', incrementUnread: false })
    database.upsertChat({ id: groupId, title: 'Regular group', kind: 'group' })
    database.storeMessage({ id: 'group-message', chatId: groupId, fromMe: false, kind: 'text', text: 'Group',
      timestamp: 2_000, status: 'read', incrementUnread: false })
    database.upsertChat({ id: communityId, title: 'Builders community', kind: 'community', classificationKnown: true })
    database.upsertChat({ id: announcementId, title: 'Announcements', kind: 'group', communityId,
      isAnnouncement: true, classificationKnown: true })
    database.upsertChat({ id: childId, title: 'Design group', kind: 'group', communityId, classificationKnown: true })
    database.storeMessage({ id: 'community-message', chatId: childId, fromMe: true, kind: 'text', text: 'Community child',
      timestamp: 3_000, status: 'delivered', incrementUnread: false })
    database.upsertChat({ id: channelId, title: 'Product news', kind: 'channel', description: 'Official updates',
      classificationKnown: true })

    expect(database.listChats({ category: 'direct' }).items.map((chat) => chat.id)).toEqual([directId])
    expect(database.listChats({ category: 'group' }).items.map((chat) => chat.id)).toEqual([groupId])
    expect(database.listChats({ category: 'channel' }).items).toEqual([
      expect.objectContaining({ id: channelId, kind: 'channel', readOnly: true, description: 'Official updates' })
    ])
    expect(database.listChats({ category: 'community' }).items.map((chat) => chat.id)).toEqual([childId])
    expect(database.listCommunities({}).items).toEqual([
      expect.objectContaining({ id: communityId, title: 'Builders community', children: [
        expect.objectContaining({ id: announcementId, isAnnouncement: true, communityId }),
        expect.objectContaining({ id: childId, communityId, lastMessageId: 'community-message',
          lastMessageFromMe: true, lastMessageStatus: 'delivered' })
      ] })
    ])
    database.close()
  })

  it('backs up and merges phone and LID chat variants without losing messages or metadata', async () => {
    const { database, directory } = createDatabase()
    const phoneJid = '15550009999@s.whatsapp.net'
    const lid = '90000123456789@lid'
    database.upsertContact({ id: phoneJid, phoneNumber: '15550009999', name: 'Merged Contact' })
    database.upsertChat({ id: phoneJid, title: '+15550009999', kind: 'direct', unreadCount: 2, archived: true, pinned: false })
    database.upsertChat({ id: lid, title: '+90000123456789', kind: 'direct', unreadCount: 1, archived: false, pinned: true })
    database.storeMessage({ id: 'phone-message', chatId: phoneJid, fromMe: false, kind: 'text', text: 'from phone chat',
      timestamp: 1_000, status: 'delivered', incrementUnread: false })
    database.storeMessage({ id: 'lid-message', chatId: lid, fromMe: true, kind: 'text', text: 'newest canonical message',
      timestamp: 2_000, status: 'sent', incrementUnread: false })

    const backupPath = await database.backupTo(join(directory, 'backups'))
    const merge = database.linkContactLid(lid, phoneJid)

    expect(backupPath).toContain('backups')
    expect(merge).toEqual({ chatId: lid, mergedChatIds: [phoneJid] })
    expect(database.resolveChatId(phoneJid)).toBe(lid)
    expect(database.getChat(phoneJid)).toMatchObject({ id: lid, title: 'Merged Contact', pinned: true, archived: false,
      unreadCount: 2, lastMessage: 'newest canonical message' })
    expect(database.listMessages(phoneJid).items.map((message) => message.id)).toEqual(['phone-message', 'lid-message'])
    expect(database.listChats({}).items.filter((chat) => chat.id === phoneJid || chat.id === lid)).toHaveLength(1)
    database.close()
  })

  it('returns local context around a quoted or searched message', () => {
    const { database } = createDatabase()
    const chatId = '15550001234@s.whatsapp.net'
    for (let index = 0; index < 7; index += 1) {
      database.storeMessage({ id: `message-${index}`, chatId, fromMe: false, kind: 'text', text: `message ${index}`,
        timestamp: 1_000 + index, status: 'delivered', incrementUnread: false })
    }

    const context = database.getMessageContext(chatId, 'message-3', 2)

    expect(context.targetId).toBe('message-3')
    expect(context.items.map((message) => message.id)).toEqual(['message-1', 'message-2', 'message-3', 'message-4', 'message-5'])
    database.close()
  })

  it('stores stable quoted previews and readable rich message data', () => {
    const { database } = createDatabase()
    const chatId = '15550004321@s.whatsapp.net'
    database.storeMessage({ id: 'reply', chatId, fromMe: false, kind: 'rich', text: 'Two products', timestamp: 2_000,
      status: 'delivered', incrementUnread: false, quotedMessageId: 'missing-target',
      quoted: { id: 'missing-target', senderName: 'A sender', kind: 'image', text: 'Original caption' },
      rich: { type: 'album', title: 'Media album', body: 'Two products', itemCount: 2 } })

    expect(database.getMessage('reply')).toMatchObject({
      quoted: { id: 'missing-target', senderName: 'A sender', kind: 'image', text: 'Original caption' },
      rich: { type: 'album', title: 'Media album', itemCount: 2 }
    })
    database.close()
  })

  it('hides metadata-only chats until they contain a message or draft', () => {
    const { database } = createDatabase()
    const chatId = '15550005555@s.whatsapp.net'
    database.upsertChat({ id: chatId, title: 'Metadata only', kind: 'direct' })
    expect(database.listChats({}).items).toEqual([])

    database.saveDraft({ chatId, text: 'A saved draft', updatedAt: Date.now() })
    expect(database.listChats({}).items.map((chat) => chat.id)).toEqual([chatId])
    database.clearDraft(chatId)
    expect(database.listChats({}).items).toEqual([])

    database.storeMessage({ id: 'visible-message', chatId, fromMe: true, kind: 'text', text: 'Now visible',
      timestamp: 3_000, status: 'sent' })
    expect(database.listChats({}).items.map((chat) => chat.id)).toEqual([chatId])
    database.close()
  })

  it('persists attachment drafts and paginates equal-timestamp search results without omissions', () => {
    const { database } = createDatabase()
    const chatId = '15550006666@s.whatsapp.net'
    database.upsertChat({ id: chatId, title: 'Draft chat', kind: 'direct' })
    database.saveDraft({ chatId, text: 'caption', attachment: {
      token: 'draft.pdf', name: 'Draft.pdf', size: 1234, mimeType: 'application/pdf',
      previewUrl: 'warish-media://drafts/draft.pdf'
    }, attachmentKind: 'document', updatedAt: Date.now() })
    expect(database.getDraft(chatId)).toMatchObject({ text: 'caption', attachmentKind: 'document',
      attachment: { token: 'draft.pdf', name: 'Draft.pdf', size: 1234 } })

    for (let index = 0; index < 60; index += 1) {
      database.storeMessage({ id: `search-${String(index).padStart(2, '0')}`, chatId, fromMe: false, kind: 'text',
        text: 'composite cursor result', timestamp: 5_000, status: 'read', incrementUnread: false })
    }
    const first = database.searchMessages('composite', chatId)
    const second = database.searchMessages('composite', chatId, first.nextCursor)
    const ids = [...first.items, ...second.items].map((message) => message.id)
    expect(ids).toHaveLength(60)
    expect(new Set(ids).size).toBe(60)
    database.close()
  })
})
