import { createHash, randomBytes } from 'node:crypto'
import type { CoreEventEnvelope, GoogleConnectionStatus, GoogleContactDraft, GoogleContactPreview } from '../shared/contracts'
import { CrmRepository } from './crm-repository'
import { WarishDatabase } from './database'

type EmitEvent = (event: CoreEventEnvelope) => void

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/contacts openid email'
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const PEOPLE_BASE_URL = 'https://people.googleapis.com/v1'

interface StoredToken {
  accessToken?: string
  refreshToken: string
  expiresAt: number
  accountEmail?: string
  connectedAt: number
}

interface PendingAuthorization {
  verifier: string
  redirectUri: string
  expiresAt: number
}

interface GooglePerson {
  resourceName?: string
  etag?: string
  names?: Array<{ displayName?: string; givenName?: string; familyName?: string }>
  phoneNumbers?: Array<{ value?: string; canonicalForm?: string }>
  emailAddresses?: Array<{ value?: string }>
}

interface GoogleSearchResponse { results?: Array<{ person?: GooglePerson }> }

export class GoogleContactsService {
  readonly #database: WarishDatabase
  readonly #crm: CrmRepository
  readonly #emit: EmitEvent
  readonly #fetch: typeof fetch
  readonly #pending = new Map<string, PendingAuthorization>()

  constructor(database: WarishDatabase, crm: CrmRepository, emit: EmitEvent, fetchImplementation: typeof fetch = fetch) {
    this.#database = database
    this.#crm = crm
    this.#emit = emit
    this.#fetch = fetchImplementation
    if (!this.#clientId() && process.env.GOOGLE_CLIENT_ID?.trim()) this.#setText('client-id', process.env.GOOGLE_CLIENT_ID.trim())
  }

  status(message?: string): GoogleConnectionStatus {
    const token = this.#token()
    return { configured: Boolean(this.#clientId()), connected: Boolean(token?.refreshToken), accountEmail: token?.accountEmail,
      connectedAt: token?.connectedAt, message }
  }

  configure(clientIdInput: string): GoogleConnectionStatus {
    const clientId = clientIdInput.trim()
    if (!clientId || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('Enter a valid Google OAuth desktop client ID')
    if (clientId !== this.#clientId()) {
      this.#setText('client-id', clientId)
      this.#database.setAuth('google', 'token', undefined)
      this.#pending.clear()
    }
    return this.#emitStatus()
  }

  beginAuth(redirectUri: string): { authorizationUrl: string; state: string } {
    const clientId = this.#clientId()
    if (!clientId) throw new Error('Configure a Google OAuth client ID first')
    assertLoopbackRedirect(redirectUri)
    this.#prunePending()
    const state = base64Url(randomBytes(24))
    const verifier = base64Url(randomBytes(48))
    const challenge = base64Url(createHash('sha256').update(verifier).digest())
    this.#pending.set(state, { verifier, redirectUri, expiresAt: Date.now() + 10 * 60 * 1000 })
    const url = new URL(GOOGLE_AUTH_URL)
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
      state
    }).toString()
    return { authorizationUrl: url.toString(), state }
  }

  async completeAuth(codeInput: string, state: string, redirectUri: string): Promise<GoogleConnectionStatus> {
    const pending = this.#pending.get(state)
    this.#pending.delete(state)
    if (!pending || pending.expiresAt < Date.now() || pending.redirectUri !== redirectUri) throw new Error('Google sign-in expired. Please try again.')
    const clientId = this.#clientId()
    if (!clientId) throw new Error('Google Contacts is not configured')
    const code = codeInput.trim()
    if (!code) throw new Error('Google did not return an authorization code')
    const response = await this.#fetch(GOOGLE_TOKEN_URL, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
        client_id: clientId, code, code_verifier: pending.verifier, grant_type: 'authorization_code', redirect_uri: redirectUri
      })
    })
    const payload = await responseJson(response) as Record<string, unknown>
    if (!response.ok || typeof payload.refresh_token !== 'string' || typeof payload.access_token !== 'string') {
      throw new Error(googleError(payload, 'Google sign-in could not be completed'))
    }
    const accessToken = payload.access_token
    let accountEmail: string | undefined
    try {
      const profileResponse = await this.#fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { authorization: `Bearer ${accessToken}` }
      })
      const profile = await responseJson(profileResponse) as Record<string, unknown>
      if (profileResponse.ok && typeof profile.email === 'string') accountEmail = profile.email
    } catch { /* Contacts remain usable when the optional account label cannot be read. */ }
    const token: StoredToken = {
      accessToken,
      refreshToken: payload.refresh_token,
      expiresAt: Date.now() + Math.max(60, Number(payload.expires_in ?? 3_600)) * 1_000 - 30_000,
      accountEmail,
      connectedAt: Date.now()
    }
    this.#storeToken(token)
    return this.#emitStatus()
  }

  disconnect(): GoogleConnectionStatus {
    this.#database.setAuth('google', 'token', undefined)
    this.#pending.clear()
    return this.#emitStatus()
  }

  async previewContact(contactId: string): Promise<GoogleContactPreview> {
    const draft = this.#crm.contactDraft(contactId)
    const linked = this.#crm.googleLink(contactId)
    if (linked) {
      try {
        const person = await this.#person(linked.resourceName)
        return { mode: 'update', draft, matches: [toMatch(person)], selectedResourceName: linked.resourceName }
      } catch { /* A deleted or inaccessible linked Google record falls back to duplicate search. */ }
    }
    const people = await this.#exactPhoneMatches(draft.phoneNumber)
    const matches = people.map(toMatch)
    return { mode: matches.length === 0 ? 'create' : matches.length === 1 ? 'update' : 'choose', draft, matches,
      selectedResourceName: matches.length === 1 ? matches[0]?.resourceName : undefined }
  }

  async saveContact(contactId: string, draftInput: GoogleContactDraft, selectedResourceName?: string): Promise<ReturnType<CrmRepository['markGoogleLinked']>> {
    const draft = validateDraft(draftInput)
    const forceCreate = selectedResourceName === '__create__'
    let resourceName = forceCreate ? undefined : selectedResourceName?.trim()
    if (!resourceName && !forceCreate) {
      const matches = await this.#exactPhoneMatches(draft.phoneNumber)
      if (matches.length > 1) throw new Error('Choose the matching Google contact before saving')
      resourceName = matches[0]?.resourceName
    }
    const body = personBody(draft)
    let person: GooglePerson
    if (resourceName) {
      if (!/^people\/[\w-]+$/.test(resourceName)) throw new Error('Invalid Google contact')
      const current = await this.#person(resourceName)
      person = await this.#api<GooglePerson>(
        `${PEOPLE_BASE_URL}/${encodeResourceName(resourceName)}:updateContact?updatePersonFields=names,phoneNumbers,emailAddresses,organizations&personFields=names,phoneNumbers,emailAddresses,organizations`,
        { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, etag: current.etag }) }
      )
    } else {
      person = await this.#api<GooglePerson>(
        `${PEOPLE_BASE_URL}/people:createContact?personFields=names,phoneNumbers,emailAddresses,organizations`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      )
    }
    if (!person.resourceName) throw new Error('Google did not return the saved contact')
    const token = this.#token()
    return this.#crm.markGoogleLinked(contactId, person.resourceName, person.etag, token?.accountEmail)
  }

  async #exactPhoneMatches(phoneNumber: string): Promise<GooglePerson[]> {
    const normalized = normalizePhone(phoneNumber)
    if (!normalized) return []
    // People API documents an empty search as the cache warm-up call. Its result is intentionally ignored.
    try {
      await this.#api(`${PEOPLE_BASE_URL}/people:searchContacts?query=&readMask=names,phoneNumbers,emailAddresses&pageSize=1`)
    } catch { /* The actual search below still succeeds for accounts whose cache is already warm. */ }
    const query = encodeURIComponent(normalized)
    const response = await this.#api<GoogleSearchResponse>(
      `${PEOPLE_BASE_URL}/people:searchContacts?query=${query}&readMask=names,phoneNumbers,emailAddresses&pageSize=30`
    )
    const people = (response.results ?? []).flatMap((result) => result.person ? [result.person] : [])
    return people.filter((person) => (person.phoneNumbers ?? []).some((phone) =>
      normalizePhone(phone.canonicalForm ?? phone.value ?? '') === normalized))
  }

  #person(resourceName: string): Promise<GooglePerson> {
    if (!/^people\/[\w-]+$/.test(resourceName)) throw new Error('Invalid Google contact')
    return this.#api<GooglePerson>(`${PEOPLE_BASE_URL}/${encodeResourceName(resourceName)}?personFields=names,phoneNumbers,emailAddresses,organizations`)
  }

  async #api<T = Record<string, unknown>>(url: string, init: RequestInit = {}, retry = true): Promise<T> {
    const accessToken = await this.#accessToken()
    const response = await this.#fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers).entries()),
      authorization: `Bearer ${accessToken}` } })
    if (response.status === 401 && retry) {
      const token = this.#token()
      if (token) { token.expiresAt = 0; this.#storeToken(token) }
      return this.#api<T>(url, init, false)
    }
    const payload = await responseJson(response) as T & Record<string, unknown>
    if (!response.ok) throw new Error(googleError(payload, `Google Contacts request failed (${response.status})`))
    return payload
  }

  async #accessToken(): Promise<string> {
    const token = this.#token()
    if (!token?.refreshToken) throw new Error('Connect Google Contacts first')
    if (token.accessToken && token.expiresAt > Date.now()) return token.accessToken
    const clientId = this.#clientId()
    if (!clientId) throw new Error('Google Contacts is not configured')
    const response = await this.#fetch(GOOGLE_TOKEN_URL, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
        client_id: clientId, refresh_token: token.refreshToken, grant_type: 'refresh_token'
      }) })
    const payload = await responseJson(response) as Record<string, unknown>
    if (!response.ok || typeof payload.access_token !== 'string') {
      if (response.status === 400) this.#database.setAuth('google', 'token', undefined)
      this.#emitStatus('Google authorization expired. Connect the account again.')
      throw new Error(googleError(payload, 'Google authorization expired'))
    }
    token.accessToken = payload.access_token
    token.expiresAt = Date.now() + Math.max(60, Number(payload.expires_in ?? 3_600)) * 1_000 - 30_000
    this.#storeToken(token)
    return token.accessToken
  }

  #clientId(): string | undefined { return this.#text('client-id') }
  #token(): StoredToken | undefined {
    const value = this.#database.getAuth('google', 'token')
    if (!value) return undefined
    try {
      const token = JSON.parse(value.toString('utf8')) as StoredToken
      return token && typeof token.refreshToken === 'string' ? token : undefined
    } catch { return undefined }
  }
  #storeToken(token: StoredToken): void { this.#database.setAuth('google', 'token', Buffer.from(JSON.stringify(token))) }
  #text(key: string): string | undefined { return this.#database.getAuth('google', key)?.toString('utf8').trim() || undefined }
  #setText(key: string, value: string): void { this.#database.setAuth('google', key, Buffer.from(value, 'utf8')) }
  #prunePending(): void {
    const now = Date.now()
    for (const [state, pending] of this.#pending) if (pending.expiresAt < now) this.#pending.delete(state)
  }
  #emitStatus(message?: string): GoogleConnectionStatus {
    const status = this.status(message)
    this.#emit({ type: 'google.statusChanged', payload: status })
    return status
  }
}

function validateDraft(input: GoogleContactDraft): GoogleContactDraft {
  const name = input.name?.trim().slice(0, 160)
  const phoneNumber = input.phoneNumber?.trim().slice(0, 40)
  if (!name) throw new Error('Contact name cannot be empty')
  if (!normalizePhone(phoneNumber)) throw new Error('Enter a valid phone number')
  return { name, phoneNumber, email: input.email?.trim().slice(0, 254) || undefined,
    company: input.company?.trim().slice(0, 160) || undefined }
}

function personBody(draft: GoogleContactDraft): Record<string, unknown> {
  const parts = draft.name.trim().split(/\s+/)
  const familyName = parts.length > 1 ? parts.pop() : undefined
  const givenName = parts.join(' ') || draft.name.trim()
  return {
    names: [{ givenName, ...(familyName ? { familyName } : {}) }],
    phoneNumbers: [{ value: draft.phoneNumber, type: 'mobile' }],
    emailAddresses: draft.email ? [{ value: draft.email }] : [],
    organizations: draft.company ? [{ name: draft.company }] : []
  }
}

function toMatch(person: GooglePerson): GoogleContactPreview['matches'][number] {
  if (!person.resourceName) throw new Error('Google returned a contact without an identifier')
  return { resourceName: person.resourceName,
    name: person.names?.[0]?.displayName ?? ([person.names?.[0]?.givenName, person.names?.[0]?.familyName]
      .filter(Boolean).join(' ') || 'Unnamed contact'),
    phoneNumbers: (person.phoneNumbers ?? []).flatMap((phone) => phone.value ? [phone.value] : []),
    email: person.emailAddresses?.[0]?.value }
}

function normalizePhone(value: string): string { return value.replace(/\D/g, '').replace(/^00/, '') }
function base64Url(value: Uint8Array): string { return Buffer.from(value).toString('base64url') }
function assertLoopbackRedirect(value: string): void {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Invalid Google redirect address') }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/oauth/google') {
    throw new Error('Invalid Google redirect address')
  }
}
function encodeResourceName(value: string): string { return value.split('/').map(encodeURIComponent).join('/') }
async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return {}
  try { return JSON.parse(text) as unknown } catch { return { error_description: text.slice(0, 400) } }
}
function googleError(payload: Record<string, unknown>, fallback: string): string {
  if (typeof payload.error_description === 'string') return payload.error_description
  if (typeof payload.error === 'string') return payload.error
  if (payload.error && typeof payload.error === 'object' && 'message' in payload.error && typeof payload.error.message === 'string') {
    return payload.error.message
  }
  return fallback
}
