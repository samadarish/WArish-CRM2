import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CrmRepository } from '../src/core/crm-repository'
import { WarishDatabase } from '../src/core/database'
import { GoogleContactsService } from '../src/core/google-contacts'
import type { CoreEventEnvelope } from '../src/shared/contracts'

const directories: string[] = []

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}
function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.toString() : input.url
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('GoogleContactsService', () => {
  it('uses PKCE, detects exact phone duplicates, updates with an etag, and stores tokens encrypted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'warish-google-test-'))
    directories.push(directory)
    const database = new WarishDatabase(join(directory, 'warish.sqlite'), Buffer.alloc(32, 4), pino({ enabled: false }))
    const events: CoreEventEnvelope[] = []
    const crm = new CrmRepository(database, (event) => events.push(event))
    const jid = '919876543210@s.whatsapp.net'
    database.upsertContact({ id: jid, phoneNumber: '919876543210', pushName: 'WhatsApp Name' })
    database.upsertChat({ id: jid, title: '+919876543210', kind: 'direct' })
    const contact = crm.ensureContact(jid)
    crm.updateContact(contact.id, { email: 'buyer@example.com', company: 'Buyer Co' })

    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input)
      calls.push({ url, init })
      if (url.includes('oauth2.googleapis.com/token')) return Promise.resolve(json({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 }))
      if (url.includes('oauth2/v2/userinfo')) return Promise.resolve(json({ email: 'owner@example.com' }))
      if (url.includes('people:searchContacts')) {
        const query = new URL(url).searchParams.get('query')
        return Promise.resolve(query ? json({ results: [{ person: { resourceName: 'people/c123', etag: 'search-etag',
          names: [{ displayName: 'Existing Buyer' }], phoneNumbers: [{ value: '+91 98765 43210' }],
          emailAddresses: [{ value: 'old@example.com' }] } }] }) : json({ results: [] }))
      }
      if (url.includes('people/c123:updateContact')) return Promise.resolve(json({ resourceName: 'people/c123', etag: 'new-etag' }))
      if (url.includes('people/c123?')) return Promise.resolve(json({ resourceName: 'people/c123', etag: 'current-etag',
        names: [{ displayName: 'Existing Buyer' }], phoneNumbers: [{ value: '+91 98765 43210' }] }))
      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })
    const google = new GoogleContactsService(database, crm, (event) => events.push(event), fetchMock as typeof fetch)
    expect(google.configure('123456789-desktop.apps.googleusercontent.com')).toMatchObject({ configured: true, connected: false })
    const redirectUri = 'http://127.0.0.1:54321/oauth/google'
    const authorization = google.beginAuth(redirectUri)
    const authUrl = new URL(authorization.authorizationUrl)
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authUrl.searchParams.get('code_challenge')).toMatch(/^[\w-]{40,}$/)
    expect(authUrl.searchParams.get('redirect_uri')).toBe(redirectUri)
    expect(authUrl.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/contacts')

    await expect(google.completeAuth('oauth-code', authorization.state, redirectUri)).resolves.toMatchObject({
      connected: true, accountEmail: 'owner@example.com'
    })
    const encrypted = database.db.prepare("SELECT value FROM auth_store WHERE category='google' AND key_id='token'").get() as { value: Uint8Array }
    expect(Buffer.from(encrypted.value).toString()).not.toContain('refresh-secret')

    const preview = await google.previewContact(contact.id)
    expect(preview).toMatchObject({ mode: 'update', selectedResourceName: 'people/c123',
      matches: [{ resourceName: 'people/c123', name: 'Existing Buyer' }] })
    const saved = await google.saveContact(contact.id, { ...preview.draft, name: 'Buyer Updated' }, 'people/c123')
    expect(saved.googleLinked).toBe(true)
    expect(crm.googleLink(contact.id)).toMatchObject({ resourceName: 'people/c123', etag: 'new-etag', accountEmail: 'owner@example.com' })
    const updateCall = calls.find((call) => call.url.includes(':updateContact'))
    expect(updateCall?.init?.method).toBe('PATCH')
    expect(typeof updateCall?.init?.body).toBe('string')
    expect(JSON.parse(updateCall?.init?.body as string)).toMatchObject({ etag: 'current-etag',
      names: [{ givenName: 'Buyer', familyName: 'Updated' }], phoneNumbers: [{ value: '+919876543210' }] })
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['google.statusChanged', 'crm.changed']))
    database.close()
  })

  it('rejects stale OAuth state and allows an explicit create when duplicate phone records exist', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'warish-google-test-'))
    directories.push(directory)
    const database = new WarishDatabase(join(directory, 'warish.sqlite'), Buffer.alloc(32, 5), pino({ enabled: false }))
    const crm = new CrmRepository(database, () => undefined)
    const jid = '15551234567@s.whatsapp.net'
    database.upsertContact({ id: jid, phoneNumber: '15551234567', pushName: 'New Lead' })
    database.upsertChat({ id: jid, title: '+15551234567', kind: 'direct' })
    const contact = crm.ensureContact(jid)
    let searches = 0
    const fetchMock = vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = requestUrl(input)
      if (url.includes('/token')) return Promise.resolve(json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }))
      if (url.includes('/userinfo')) return Promise.resolve(json({ email: 'owner@example.com' }))
      if (url.includes('searchContacts')) { searches += 1; return Promise.resolve(json({ results: [] })) }
      if (url.includes('people:createContact')) return Promise.resolve(json({ resourceName: 'people/new-contact', etag: 'created-etag' }))
      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })
    const google = new GoogleContactsService(database, crm, () => undefined, fetchMock as typeof fetch)
    google.configure('desktop-client.apps.googleusercontent.com')
    const redirect = 'http://127.0.0.1:51234/oauth/google'
    google.beginAuth(redirect)
    await expect(google.completeAuth('code', 'wrong-state', redirect)).rejects.toThrow('expired')
    const retry = google.beginAuth(redirect)
    await google.completeAuth('code', retry.state, redirect)
    await google.saveContact(contact.id, crm.contactDraft(contact.id), '__create__')
    expect(searches).toBe(0)
    expect(crm.googleLink(contact.id)?.resourceName).toBe('people/new-contact')
    database.close()
  })
})
