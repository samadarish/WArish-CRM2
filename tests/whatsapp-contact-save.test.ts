import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CrmRepository } from '../src/core/crm-repository'
import { WarishDatabase } from '../src/core/database'
import type { MediaManager } from '../src/core/media-manager'
import { WhatsAppClient, addOrEditWhatsAppContact } from '../src/core/whatsapp-client'

const directories: string[] = []

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('WhatsApp contact saving', () => {
  it('sends phone and LID addressing to the primary WhatsApp address book', async () => {
    const addOrEditContact = vi.fn().mockResolvedValue(undefined)
    const socket = { addOrEditContact } as Parameters<typeof addOrEditWhatsAppContact>[0]

    await addOrEditWhatsAppContact(socket, '919876543210@s.whatsapp.net', 'Priya Sharma', {
      phoneJid: '919876543210@s.whatsapp.net', lidJid: '12345678901234@lid'
    })

    expect(addOrEditContact).toHaveBeenCalledWith('919876543210@s.whatsapp.net', {
      fullName: 'Priya Sharma', firstName: 'Priya', pnJid: '919876543210@s.whatsapp.net',
      lidJid: '12345678901234@lid', saveOnPrimaryAddressbook: true
    })
  })

  it('rejects blank names and does not save while WhatsApp is offline', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'warish-contact-save-'))
    directories.push(directory)
    const database = new WarishDatabase(join(directory, 'warish.sqlite'), Buffer.alloc(32, 4), pino({ enabled: false }))
    const chatId = '919876543210@s.whatsapp.net'
    database.upsertContact({ id: chatId, phoneNumber: '919876543210', pushName: 'Priya Profile' })
    database.upsertChat({ id: chatId, title: 'Priya Profile', kind: 'direct' })
    const emit = vi.fn()
    const crm = new CrmRepository(database, emit)
    const client = new WhatsAppClient(database, pino({ enabled: false }), {} as MediaManager, crm, emit)

    await expect(client.saveContact(chatId, '   ')).rejects.toThrow('Contact name cannot be empty')
    await expect(client.saveContact(chatId, 'Priya Saved')).rejects.toThrow('WhatsApp is offline')
    expect(database.getContactDetails(chatId).savedName).toBeUndefined()
    database.close()
  })
})
