import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { ContactRestrictedError, CrmRepository } from '../src/core/crm-repository'
import { WarishDatabase } from '../src/core/database'
import { toAppError } from '../src/core/rpc-router'
import type { CoreEventEnvelope } from '../src/shared/contracts'

const directories: string[] = []

function setup(): { database: WarishDatabase; crm: CrmRepository; events: CoreEventEnvelope[]; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'warish-crm-test-'))
  directories.push(directory)
  const database = new WarishDatabase(join(directory, 'warish.sqlite'), Buffer.alloc(32, 9), pino({ enabled: false }))
  const events: CoreEventEnvelope[] = []
  return { database, crm: new CrmRepository(database, (event) => events.push(event)), events, directory }
}

function directContact(database: WarishDatabase, user: string, input: { savedName?: string; whatsappName?: string; lid?: boolean } = {}): string {
  const jid = `${user}@${input.lid ? 'lid' : 's.whatsapp.net'}`
  database.upsertContact({ id: jid, phoneNumber: input.lid ? undefined : user, name: input.savedName, pushName: input.whatsappName })
  database.upsertChat({ id: jid, title: input.savedName ?? input.whatsappName ?? `+${user}`, kind: 'direct' })
  return jid
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('CrmRepository', () => {
  it('turns only recent unknown inbound WhatsApp conversations into leads', () => {
    const { database, crm, events } = setup()
    const unknown = directContact(database, '919811112222', { whatsappName: 'Anita Profile' })
    const saved = directContact(database, '919833334444', { savedName: 'Saved Supplier', whatsappName: 'Supplier Profile' })

    expect(crm.ensureInboundLead(unknown, Date.now(), true)).toBe(true)
    expect(crm.ensureInboundLead(unknown, Date.now() + 1, true)).toBe(false)
    expect(crm.ensureInboundLead(saved, Date.now(), true)).toBe(false)
    expect(crm.ensureInboundLead(directContact(database, '919855556666'), Date.now() - 91 * 24 * 60 * 60 * 1000, true)).toBe(false)

    expect(crm.listContacts({ lifecycle: 'lead' })).toHaveLength(1)
    expect(crm.listContacts({ lifecycle: 'lead' })[0]).toMatchObject({ name: 'Anita Profile', phoneNumber: '+919811112222',
      stageKey: 'new', source: 'whatsapp' })
    expect(events.filter((event) => event.type === 'crm.changed')).toHaveLength(1)
    database.close()
  })

  it('calculates orders, payments, customer conversion, notes, tasks, and dashboard totals', () => {
    const { database, crm } = setup()
    const chatId = directContact(database, '919800001234', { whatsappName: 'Prospect' })
    const contact = crm.ensureContact(chatId)
    const updated = crm.updateContact(contact.id, { email: 'hello@example.com', company: 'Acme',
      tags: [{ name: 'Hot', color: '#dc2626' }] })
    expect(updated.tags).toEqual([expect.objectContaining({ name: 'Hot', color: '#dc2626' })])
    expect(crm.addNote(contact.id, 'Asked for a delivery quote').body).toBe('Asked for a delivery quote')

    const catalog = crm.saveCatalog({ type: 'product', name: 'Premium kit', unitPrice: 100 })
    const order = crm.saveOrder({ contactId: contact.id, status: 'completed', items: [{ catalogItemId: catalog.id,
      type: 'product', name: catalog.name, quantity: 2, unitPrice: 100, discount: 10, taxRate: 10 }],
    payments: [{ amount: 100, paidAt: Date.now(), method: 'UPI' }] })
    expect(order).toMatchObject({ subtotal: 200, discount: 10, tax: 19, total: 209, paidAmount: 100,
      balanceAmount: 109, paymentStatus: 'partial', status: 'completed' })
    expect(crm.getContact({ contactId: contact.id })).toMatchObject({ lifecycle: 'customer', stageKey: 'won',
      orderCount: 1, lifetimeValue: 209 })

    const task = crm.saveTask({ contactId: contact.id, title: 'Collect balance', dueAt: Date.now() - 1_000, priority: 'high' })
    expect(crm.takeDueTaskNotifications()).toEqual([expect.objectContaining({ id: task.id, title: 'Collect balance' })])
    expect(crm.takeDueTaskNotifications()).toEqual([])
    expect(crm.dashboard()).toMatchObject({ customers: 1, overdueTasks: 1, lifetimeRevenue: 209 })
    expect(crm.activity(contact.id).map((activity) => activity.type)).toEqual(expect.arrayContaining([
      'lead-created', 'note-added', 'order-created', 'task-created'
    ]))
    database.close()
  })

  it('preserves all CRM children when WhatsApp merges phone and LID identities', () => {
    const { database, crm } = setup()
    const lid = directContact(database, '88345678901234', { lid: true, whatsappName: 'LID Profile' })
    const phone = directContact(database, '919877776666', { whatsappName: 'Phone Profile' })
    const lidContact = crm.ensureContact(lid)
    const phoneContact = crm.ensureContact(phone)
    crm.addNote(lidContact.id, 'LID-side note')
    crm.saveTask({ contactId: phoneContact.id, title: 'Phone-side task' })
    crm.saveOrder({ contactId: phoneContact.id, status: 'confirmed', items: [{ type: 'service', name: 'Consultation',
      quantity: 1, unitPrice: 500, discount: 0, taxRate: 0 }] })
    database.linkContactLid(lid, phone)

    const contacts = crm.listContacts({ lifecycle: 'active' })
    expect(contacts).toHaveLength(1)
    const merged = crm.getContact({ chatId: lid })
    expect(merged).toMatchObject({ chatId: lid, lifecycle: 'customer', orderCount: 1, lifetimeValue: 0 })
    expect(crm.listNotes(merged.id).map((note) => note.body)).toContain('LID-side note')
    expect(crm.listTasks({ contactId: merged.id }).map((task) => task.title)).toContain('Phone-side task')
    expect(crm.listOrders(merged.id)).toHaveLength(1)
    database.close()
  })

  it('exposes chat CRM signals and keeps bounded source-message snapshots immutable', () => {
    const { database, crm } = setup()
    const chatId = directContact(database, '919899991111', { whatsappName: 'Lead Profile' })
    const originalText = `Customer requirement: ${'x'.repeat(700)}`
    database.storeMessage({ id: 'crm-source-message', chatId, fromMe: false, senderName: 'Lead Profile', kind: 'text',
      text: originalText, timestamp: Date.now() - 2_000, status: 'read' })
    const contact = crm.ensureContact(chatId)
    crm.updateContact(contact.id, { name: 'CRM Alias', doNotContact: true, consentStatus: 'denied' })
    crm.setStage(contact.id, 'stage-qualified')
    const note = crm.saveNote({ contactId: contact.id, body: 'Clarify the requirement', sourceMessageId: 'crm-source-message' })
    const task = crm.saveTask({ contactId: contact.id, title: 'Send revised quote', dueAt: Date.now() + 60_000,
      priority: 'high', sourceMessageId: 'crm-source-message' })

    expect(note.sourceMessage).toMatchObject({ messageId: 'crm-source-message', fromMe: false, senderName: 'Lead Profile' })
    expect(note.sourceMessage?.text).toHaveLength(500)
    expect(task.sourceMessage).toEqual(note.sourceMessage)
    expect(database.getChat(chatId).crm).toMatchObject({ contactId: contact.id, name: 'CRM Alias', stageKey: 'qualified',
      openTaskCount: 1, restricted: true, nextTask: { id: task.id, title: 'Send revised quote', priority: 'high' } })

    database.markMessageEdited('crm-source-message', 'Changed after linking')
    const updated = crm.saveNote({ id: note.id, contactId: contact.id, body: 'Updated CRM note' })
    expect(updated.sourceMessage).toEqual(note.sourceMessage)
    expect(() => crm.assertCanContact(chatId, false)).toThrow(/Confirmation required/)
    expect(() => crm.assertCanContact(chatId, true)).not.toThrow()
    expect(toAppError(new ContactRestrictedError('CRM Alias', ['consent is denied']))).toMatchObject({
      code: 'CONTACT_RESTRICTED', retryable: false
    })
    database.close()
  })

  it('backfills only unsaved inbound conversations from the previous 90 days during migration v9', () => {
    const { database, directory } = setup()
    const recentUnknown = directContact(database, '919811110001', { whatsappName: 'Recent Lead' })
    const recentSaved = directContact(database, '919811110002', { savedName: 'Saved Contact' })
    const oldUnknown = directContact(database, '919811110003', { whatsappName: 'Old Contact' })
    const outgoingOnly = directContact(database, '919811110004')
    const now = Date.now()
    database.storeMessage({ id: 'recent-unknown', chatId: recentUnknown, fromMe: false, kind: 'text', text: 'Enquiry', timestamp: now - 1_000, status: 'read' })
    database.storeMessage({ id: 'recent-saved', chatId: recentSaved, fromMe: false, kind: 'text', text: 'Hello', timestamp: now - 2_000, status: 'read' })
    database.storeMessage({ id: 'old-unknown', chatId: oldUnknown, fromMe: false, kind: 'text', text: 'Old', timestamp: now - 91 * 24 * 60 * 60 * 1000, status: 'read' })
    database.storeMessage({ id: 'outgoing', chatId: outgoingOnly, fromMe: true, kind: 'text', text: 'Sent', timestamp: now - 3_000, status: 'sent' })
    const path = database.path
    database.close()

    const legacy = new DatabaseSync(path)
    legacy.exec(`
      DROP TABLE IF EXISTS google_contact_links; DROP TABLE crm_activity; DROP TABLE crm_payments; DROP TABLE crm_order_items;
      DROP TABLE crm_tasks; DROP TABLE crm_orders; DROP TABLE crm_notes; DROP TABLE crm_contact_tags; DROP TABLE crm_tags;
      DROP TABLE crm_catalog_items; DROP TABLE crm_contacts; DROP TABLE crm_pipeline_stages;
      DELETE FROM schema_migrations WHERE version>=9;
    `)
    legacy.close()

    const migrated = new WarishDatabase(path, Buffer.alloc(32, 9), pino({ enabled: false }))
    const crm = new CrmRepository(migrated, () => undefined)
    expect(crm.listContacts({ lifecycle: 'lead' }).map((contact) => contact.chatId)).toEqual([recentUnknown])
    expect(crm.activity(crm.listContacts({ lifecycle: 'lead' })[0]!.id)[0]).toMatchObject({ type: 'lead-created',
      summary: 'Imported from recent WhatsApp enquiries' })
    migrated.close()
    expect(directory).toBeTruthy()
  })
})
