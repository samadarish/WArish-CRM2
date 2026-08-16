import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

let application: ElectronApplication
let page: Page
let userDataPath: string

interface BrowserElement {
  ownerDocument: { defaultView: { getComputedStyle(target: unknown): { fontSize: string; transitionDuration: string } } }
}

interface BrowserBoxElement {
  getBoundingClientRect(): { width: number; height: number }
}

interface BrowserAnimatedElement {
  getAnimations(): Array<{ playState: string }>
}

interface BrowserClipboardElement {
  ownerDocument: { defaultView: {
    atob(value: string): string
    DataTransfer: new () => { items: { add(file: unknown): void } }
    File: new (parts: unknown[], name: string, options: { type: string }) => unknown
    ClipboardEvent: new (type: string, options: {
      bubbles: boolean
      cancelable: boolean
      clipboardData: unknown
    }) => unknown
  } }
  dispatchEvent(event: unknown): boolean
}

interface BrowserScrollElement {
  scrollTop: number
  scrollHeight: number
}

interface BrowserLifecycleElement {
  getAttribute(name: string): string | null
  style: { getPropertyValue(name: string): string }
  ownerDocument: { defaultView: { getComputedStyle(target: unknown): { clipPath: string } } }
}

interface BrowserColorElement {
  ownerDocument: { defaultView: { getComputedStyle(target: unknown): { backgroundColor: string } } }
}

async function bodyFontSize(targetPage: Page): Promise<string> {
  return targetPage.locator('body').evaluate((element: unknown) => {
    const target = element as BrowserElement
    return target.ownerDocument.defaultView.getComputedStyle(target).fontSize
  })
}

test.beforeEach(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'warish-e2e-'))
  application = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${userDataPath}`],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  })
  page = await application.firstWindow()
})

test.afterEach(async () => {
  await application?.close()
  rmSync(userDataPath, { recursive: true, force: true })
})

test('starts at the supported desktop width and exposes settings diagnostics', async () => {
  await expect(page).toHaveTitle(/WArish/)
  await expect(page.getByRole('heading', { name: 'Welcome to WArish' })).toBeVisible()

  const viewport = await page.locator('body').boundingBox()
  if (!viewport) throw new Error('The Electron renderer body has no visible bounds')
  expect(viewport.width).toBeGreaterThanOrEqual(900)
  expect(viewport.height).toBeGreaterThanOrEqual(620)

  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('dialog', { name: 'Appearance' })).toBeVisible()
  const settingsTransition = await page.locator('.settings-panel').evaluate((element: unknown) => {
    const target = element as BrowserElement
    return target.ownerDocument.defaultView.getComputedStyle(target).transitionDuration
  })
  expect(settingsTransition).not.toBe('0s')
  await expect.poll(() => page.locator('html').getAttribute('data-density')).toBe('dense')
  await page.getByRole('button', { name: 'Salesforce black' }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('salesforce-black')
  await page.getByRole('button', { name: 'comfortable' }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-density')).toBe('comfortable')
  const readableFontSize = await bodyFontSize(page)
  await page.getByRole('button', { name: 'dense', exact: true }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-density')).toBe('dense')
  expect(await bodyFontSize(page)).toBe(readableFontSize)
  await page.getByRole('button', { name: 'Ultra dense' }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-density-mode')).toBe('ultra-dense')
  await expect.poll(() => page.locator('html').getAttribute('data-density')).toBe('dense')
  expect(await bodyFontSize(page)).toBe(readableFontSize)
  await page.getByRole('button', { name: 'grid' }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-conversation-background')).toBe('grid')
  await page.getByRole('checkbox', { name: /Disable animations/i }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-motion')).toBe('reduced')
  const transitionDuration = await page.locator('.option-grid button').first().evaluate((element: unknown) => {
    const target = element as BrowserElement
    return target.ownerDocument.defaultView.getComputedStyle(target).transitionDuration
  })
  expect(transitionDuration).toBe('0s')
  await page.getByRole('button', { name: 'collapsed' }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-navigation')).toBe('collapsed')
  await page.getByRole('button', { name: 'auto' }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-navigation')).toBe('auto')
  await page.getByRole('button', { name: 'Messaging' }).click()
  await expect(page.getByRole('checkbox', { name: /Enter to send/i })).toBeChecked()
  await page.getByRole('checkbox', { name: /Show chat previews/i }).click()
  await expect(page.getByRole('checkbox', { name: /Show chat previews/i })).not.toBeChecked()
  await page.getByRole('button', { name: 'Storage & contacts' }).click()
  await expect(page.getByText('0 saved contact names')).toBeVisible()
  await expect(page.getByText(/0 WhatsApp profile names/)).toBeVisible()
  await page.getByRole('button', { name: 'Diagnostics' }).click()
  await page.getByRole('button', { name: 'View error logs' }).click()
  await expect(page.getByRole('heading', { name: 'Error logs' })).toBeVisible()
  await expect(page.getByText(/No errors recorded|Recent warnings and errors/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Close settings' }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
})

test('renders the Flow identity across every explicit app theme', async () => {
  const visualDirectory = resolve('test-results', 'visual', 'brand-themes')
  mkdirSync(visualDirectory, { recursive: true })
  await page.setViewportSize({ width: 1280, height: 820 })
  const mark = page.locator('.brand-lockup .brand-mark')
  await expect(mark).toHaveAttribute('data-brand-variant', 'full')

  const themes = [
    { button: 'Light', theme: 'light', tone: 'light' },
    { button: 'Dark', theme: 'dark', tone: 'dark' },
    { button: 'Black', theme: 'black', tone: 'dark' },
    { button: 'Salesforce black', theme: 'salesforce-black', tone: 'dark' }
  ] as const
  for (const selection of themes) {
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: selection.button, exact: true }).click()
    await page.getByRole('button', { name: 'Close settings' }).click()
    await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe(selection.theme)
    await expect.poll(() => page.locator('html').getAttribute('data-brand-tone')).toBe(selection.tone)
    await expect(mark.locator(`.brand-mark-image.${selection.tone}`)).toBeVisible()
    await expect(mark.locator(`.brand-mark-image.${selection.tone === 'light' ? 'dark' : 'light'}`)).toBeHidden()
    await page.screenshot({ path: join(visualDirectory, `warish-flow-${selection.theme}-1280x820.png`), animations: 'disabled' })
  }
})

test('keeps the offline workspace available and opens the dedicated CRM', async () => {
  await expect(page.getByRole('heading', { name: 'Welcome to WArish' })).toBeVisible()
  await application.close()
  const database = new DatabaseSync(join(userDataPath, 'warish.sqlite'))
  database.prepare("INSERT INTO accounts(id, created_at, linked_at) VALUES ('primary', ?, ?) ON CONFLICT(id) DO UPDATE SET linked_at=excluded.linked_at")
    .run(Date.now(), Date.now())
  database.close()

  application = await electron.launch({ args: [resolve('.'), `--user-data-dir=${userDataPath}`],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } })
  page = await application.firstWindow()
  await expect(page.getByRole('button', { name: 'CRM' })).toBeVisible()
  await expect(page.locator('.nav-brand .brand-mark')).toHaveAttribute('data-brand-variant', 'compact')
  await page.setViewportSize({ width: 900, height: 620 })
  const crmNavigation = page.getByRole('button', { name: 'CRM' })
  await crmNavigation.hover()
  await expect(page.getByRole('tooltip', { name: 'CRM' })).toBeVisible()
  await crmNavigation.click()
  await expect(page.getByRole('tooltip', { name: 'CRM' })).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  await expect(page.getByText('Revenue this month')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Leads', exact: true })).toBeVisible()
  await expect(page.getByText('No enquiries yet')).toBeVisible()
  const visualDirectory = resolve('test-results', 'visual')
  mkdirSync(visualDirectory, { recursive: true })
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.screenshot({ path: join(visualDirectory, 'warish-crm-light-1366x768.png'), animations: 'disabled' })
})

test('virtualizes a full CRM contact list while keeping the final record reachable', async () => {
  await application.close()
  const database = new DatabaseSync(join(userDataPath, 'warish.sqlite'))
  database.prepare("UPDATE accounts SET linked_at=? WHERE id='primary'").run(Date.now())
  const identity = database.prepare(`INSERT INTO contact_identities(identity_id, phone_jid, phone_number, saved_name, whatsapp_name, avatar_failures, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)`)
  const alias = database.prepare('INSERT INTO contact_identity_aliases(alias_id, identity_id, updated_at) VALUES (?, ?, ?)')
  const chat = database.prepare(`INSERT INTO chats(id, account_id, title, kind, last_message, last_message_at, last_message_id, unread_count, archived, pinned, updated_at)
    VALUES (?, 'primary', ?, 'direct', 'CRM performance fixture', ?, NULL, 0, 0, 0, ?)`)
  const crm = database.prepare(`INSERT INTO crm_contacts(id, identity_id, chat_id, lifecycle, stage_id, name, source, created_at, last_activity_at, updated_at)
    VALUES (?, ?, ?, 'lead', 'stage-new', ?, 'fixture', ?, ?, ?)`)
  const baseTime = Date.now() - 200_000
  database.exec('BEGIN')
  for (let index = 0; index < 120; index += 1) {
    const sequence = String(index + 1).padStart(3, '0')
    const identityId = `crm-perf-${sequence}`
    const phone = `1555100${sequence}`
    const chatId = `${phone}@s.whatsapp.net`
    const name = `Lead ${sequence}`
    const timestamp = baseTime + index
    identity.run(identityId, chatId, phone, name, name, timestamp)
    alias.run(chatId, identityId, timestamp)
    chat.run(chatId, name, timestamp, timestamp)
    crm.run(`crm-${sequence}`, identityId, chatId, name, timestamp, timestamp, timestamp)
  }
  const wonTimestamp = baseTime + 121
  const wonChatId = '15551999999@s.whatsapp.net'
  identity.run('crm-perf-won', wonChatId, '15551999999', 'Won E2E', 'Won E2E', wonTimestamp)
  alias.run(wonChatId, 'crm-perf-won', wonTimestamp)
  chat.run(wonChatId, 'Won E2E', wonTimestamp, wonTimestamp)
  database.prepare(`INSERT INTO crm_contacts(id, identity_id, chat_id, lifecycle, stage_id, name, source, created_at, last_activity_at, updated_at)
    VALUES ('crm-won', 'crm-perf-won', ?, 'customer', 'stage-won', 'Won E2E', 'fixture', ?, ?, ?)`)
    .run(wonChatId, wonTimestamp, wonTimestamp, wonTimestamp)
  database.exec('COMMIT')
  database.close()

  application = await electron.launch({ args: [resolve('.'), `--user-data-dir=${userDataPath}`],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } })
  page = await application.firstWindow()
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.getByRole('button', { name: 'CRM' }).click()
  await page.getByRole('navigation', { name: 'CRM sections' }).getByRole('button', { name: /^Leads/ }).click()
  const table = page.locator('.crm-virtual-table')
  await expect(table).toBeVisible()
  await expect.poll(() => table.locator('tbody tr').count()).toBeLessThan(60)
  const visualDirectory = resolve('test-results', 'visual')
  mkdirSync(visualDirectory, { recursive: true })
  await page.screenshot({ path: join(visualDirectory, 'warish-crm-leads-light-1366x768.png'), animations: 'disabled' })
  await table.evaluate((element: unknown) => {
    const target = element as BrowserScrollElement
    target.scrollTop = target.scrollHeight
  })
  await expect(page.getByText('Lead 001')).toBeVisible()
  await page.getByRole('button', { name: 'Won', exact: true }).click()
  await expect(page.getByText('Won E2E')).toBeVisible()
})

test('keeps local history in the workspace when an existing account needs relinking', async () => {
  test.setTimeout(90_000)
  await application.close()
  const database = new DatabaseSync(join(userDataPath, 'warish.sqlite'))
  database.prepare("UPDATE accounts SET linked_at=? WHERE id='primary'").run(Date.now())
  database.exec(`
    INSERT INTO contact_identities(identity_id, phone_jid, phone_number, saved_name, whatsapp_name, avatar_failures, updated_at)
      VALUES ('saved-contact', '15550001111@s.whatsapp.net', '15550001111', 'Saved Contact', 'Saved Profile', 0, 1),
             ('unsaved-contact', '15550002222@s.whatsapp.net', '15550002222', NULL, 'Profile Only', 0, 1);
    INSERT INTO contact_identity_aliases(alias_id, identity_id, updated_at)
      VALUES ('15550001111@s.whatsapp.net', 'saved-contact', 1), ('15550002222@s.whatsapp.net', 'unsaved-contact', 1);
    INSERT INTO chats(id, account_id, title, kind, last_message, last_message_at, last_message_id, unread_count, archived, pinned, updated_at)
      VALUES ('15550001111@s.whatsapp.net', 'primary', 'Saved Contact', 'direct', 'Saved contact preview', 1784390000000, 'saved-message', 0, 0, 0, 1784390000000),
             ('15550002222@s.whatsapp.net', 'primary', 'Profile Only', 'direct', 'Unsaved contact preview', 1784389900000, 'unsaved-message', 0, 0, 0, 1784389900000);
  `)
  database.close()

  application = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${userDataPath}`],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  })
  page = await application.firstWindow()

  await expect(page.getByRole('heading', { name: 'Welcome to WArish' })).not.toBeVisible()
  await expect(page.getByText('WhatsApp session expired')).toBeVisible()
  const navigation = page.getByRole('navigation', { name: 'Primary navigation' })
  expect((await navigation.getByRole('button').allTextContents()).slice(0, 7)).toEqual([
    'Chats', 'CRM', 'Groups', 'Communities', 'Channels', 'All conversations', 'Archived'
  ])
  await expect(navigation.getByRole('button', { name: 'Chats' })).toHaveAttribute('aria-current', 'page')
  const chatList = page.locator('.chat-list')
  const savedContact = chatList.getByRole('button', { name: /Saved Contact/ })
  await expect(savedContact.getByText('+15550001111')).toHaveCount(0)
  await expect(savedContact.locator('.whatsapp-profile-pill')).toHaveText('Saved Profile')
  await savedContact.click()
  const conversationHeader = page.locator('.conversation-header')
  await expect(conversationHeader.getByText('+15550001111')).toHaveCount(0)
  await expect(conversationHeader.locator('.whatsapp-profile-pill')).toHaveText('Saved Profile')
  const details = page.getByRole('complementary', { name: 'CRM contact record' })
  await expect(details).toBeVisible()
  await expect(details.getByRole('button', { name: 'Close customer details' })).toBeHidden()
  const conversationActions = conversationHeader.getByRole('group', { name: 'Conversation actions' })
  await expect(conversationActions.getByRole('button')).toHaveCount(3)
  await expect(conversationActions.getByRole('button', { name: 'Pin chat' })).toBeVisible()
  await expect(conversationActions.getByRole('button', { name: 'Mute chat' })).toBeVisible()
  await expect(conversationActions.getByRole('button', { name: 'Archive chat' })).toBeVisible()
  await expect(details.getByText('WhatsApp conversation')).toHaveCount(0)
  await expect(details.getByRole('button', { name: 'Pin', exact: true })).toHaveCount(0)
  await expect(details.getByRole('button', { name: 'Mute', exact: true })).toHaveCount(0)
  await expect(details.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0)
  await conversationActions.getByRole('button', { name: 'Pin chat' }).click()
  await expect(conversationActions.getByRole('button', { name: 'Unpin chat' })).toBeVisible()
  await expect(savedContact.locator('.chat-pinned-indicator')).toBeVisible()
  await conversationActions.getByRole('button', { name: 'Unpin chat' }).click()
  await expect(conversationActions.getByRole('button', { name: 'Pin chat' })).toBeVisible()
  await expect(savedContact.locator('.chat-pinned-indicator')).toHaveCount(0)
  await conversationActions.getByRole('button', { name: 'Mute chat' }).click()
  await expect(conversationActions.getByRole('button', { name: 'Unmute chat' })).toBeVisible()
  await conversationActions.getByRole('button', { name: 'Unmute chat' }).click()
  await expect(conversationActions.getByRole('button', { name: 'Mute chat' })).toBeVisible()
  const lifecycle = page.getByRole('region', { name: 'Sales lifecycle' })
  await expect(lifecycle).toBeVisible()
  const lifecyclePresentation = await lifecycle.locator('.sales-lifecycle-path button').evaluateAll((buttons) => buttons.map((button) => {
    const target = button as unknown as BrowserLifecycleElement
    return {
      stage: target.getAttribute('aria-label')?.replace(/^Set sales stage to /, '') ?? null,
      clipPath: target.ownerDocument.defaultView.getComputedStyle(target).clipPath,
      color: target.style.getPropertyValue('--stage-color').trim().toUpperCase()
    }
  }))
  expect(Object.fromEntries(lifecyclePresentation.map(({ stage, color }) => [stage, color]))).toEqual({
    'New enquiry': '#F59E0B',
    Qualified: '#EAB308',
    Quoted: '#8B5CF6',
    Won: '#84CC16',
    Lost: '#EF4444'
  })
  for (const stage of lifecyclePresentation) expect(stage.clipPath).toMatch(/^polygon\(/)
  await expect(lifecycle.getByRole('button', { name: 'Set sales stage to New enquiry' })).not.toHaveAttribute('aria-current')
  await expect(details.getByText('Pipeline stage')).toHaveCount(0)
  await lifecycle.getByRole('button', { name: 'Set sales stage to Qualified' }).click()
  await expect(lifecycle.getByRole('button', { name: 'Set sales stage to Qualified' })).toHaveAttribute('aria-current', 'step')
  await expect(details.locator('.crm-contact-tabs button')).toHaveText(['orders', 'overview', 'notes', 'tasks', 'activity'])
  await expect(details.getByRole('button', { name: 'orders' })).toHaveClass(/active/)
  await expect(details.getByRole('button', { name: 'New order' })).toBeVisible()
  await expect(details.getByText('Phone number')).toHaveCount(0)
  await expect(details.getByText('+15550001111')).toHaveCount(1)
  await expect.poll(() => details.evaluate((element: unknown) =>
    (element as BrowserAnimatedElement).getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0)
  const [drawerBounds, conversationBounds, messageBounds, composerBounds, chatListBounds, avatarBounds] = await Promise.all([
    details.boundingBox(), page.locator('.conversation-panel').boundingBox(), page.locator('.message-scroller').boundingBox(),
    page.locator('.composer').boundingBox(), page.locator('.chat-list-panel').boundingBox(), details.locator('.crm-contact-hero .avatar.large').boundingBox()
  ])
  if (!drawerBounds || !conversationBounds || !messageBounds || !composerBounds || !chatListBounds || !avatarBounds) {
    throw new Error('The persistent customer workspace has missing geometry')
  }
  expect(drawerBounds.width).toBeGreaterThanOrEqual(359)
  expect(drawerBounds.width).toBeLessThanOrEqual(441)
  expect(drawerBounds.x).toBeGreaterThanOrEqual(conversationBounds.x)
  expect(Math.abs(drawerBounds.x + drawerBounds.width - (conversationBounds.x + conversationBounds.width))).toBeLessThanOrEqual(3)
  expect(Math.abs(messageBounds.x + messageBounds.width - drawerBounds.x)).toBeLessThanOrEqual(3)
  expect(Math.abs(composerBounds.x + composerBounds.width - drawerBounds.x)).toBeLessThanOrEqual(3)
  expect(chatListBounds.width).toBeGreaterThanOrEqual(229)
  expect(chatListBounds.width).toBeLessThanOrEqual(291)
  expect(Math.abs(avatarBounds.width - avatarBounds.height)).toBeLessThanOrEqual(1)
  const lifecycleBounds = await lifecycle.boundingBox()
  if (!lifecycleBounds) throw new Error('The sales lifecycle path has no visible bounds')
  expect(drawerBounds.y).toBeGreaterThanOrEqual(lifecycleBounds.y + lifecycleBounds.height - 1)
  const unsavedContact = chatList.getByRole('button', { name: /\+15550002222/ })
  await expect(unsavedContact.getByText('+15550002222')).toHaveCount(1)
  await expect(unsavedContact.locator('.whatsapp-profile-pill')).toHaveText('Profile Only')
  await unsavedContact.click()
  await expect(conversationHeader.getByText('Not tracked in CRM')).toBeVisible()
  await expect(details.getByRole('button', { name: /Add to CRM/ })).toBeVisible()
  await details.getByRole('button', { name: /Add to CRM/ }).click()
  const crmRecord = page.getByRole('complementary', { name: 'CRM contact record' })
  await expect(crmRecord).toBeVisible()
  await expect(crmRecord.getByText('Profile Only', { exact: true }).first()).toBeVisible()
  await expect(crmRecord.getByRole('button', { name: 'Save contact' })).toBeVisible()
  await expect(crmRecord.getByRole('button', { name: 'orders' })).toHaveClass(/active/)
  await expect(crmRecord.getByRole('button', { name: 'New order' })).toBeVisible()
  await expect(conversationHeader.getByText('Orders')).toBeVisible()
  await expect(conversationHeader.getByText('Lifetime value')).toBeVisible()
  await expect(conversationHeader.getByText('Open tasks')).toBeVisible()
  await page.getByRole('button', { name: 'Choose an emoji' }).click()
  const emojiPicker = page.getByRole('dialog', { name: 'Choose an emoji' })
  await expect(emojiPicker).toBeVisible()
  await emojiPicker.getByRole('button', { name: 'Thumbs up' }).click()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('👍')
  await emojiPicker.getByRole('button', { name: 'Close emoji picker' }).click()
  await page.getByRole('textbox', { name: 'Message' }).fill('')

  const visualDirectory = resolve('test-results', 'visual')
  mkdirSync(visualDirectory, { recursive: true })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Salesforce black' }).click()
  await page.getByRole('button', { name: 'Ultra dense' }).click()
  await page.getByRole('button', { name: 'Close settings' }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('salesforce-black')
  await expect.poll(() => page.locator('html').getAttribute('data-density-mode')).toBe('ultra-dense')
  await page.screenshot({ path: join(visualDirectory, 'warish-salesforce-black-1920x1080.png'), animations: 'disabled' })

  await page.setViewportSize({ width: 1366, height: 768 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Black', exact: true }).click()
  await page.getByRole('button', { name: 'Close settings' }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('black')
  await page.screenshot({ path: join(visualDirectory, 'warish-black-1366x768.png'), animations: 'disabled' })

  await page.getByRole('button', { name: 'Conversation menu' }).click()
  const conversationMenu = page.getByRole('menu')
  await expect(conversationMenu).toBeVisible()
  for (const name of ['Pin chat', 'Mark as read', 'Archive chat']) {
    const menuItem = conversationMenu.getByRole('menuitem', { name })
    await expect(menuItem).toBeVisible()
    await menuItem.click({ trial: true })
  }
  await page.screenshot({ path: join(visualDirectory, 'warish-black-menu-1366x768.png'), animations: 'disabled' })
  await page.keyboard.press('Escape')
  await expect(conversationMenu).toBeHidden()
  await expect(page.getByRole('button', { name: 'Conversation menu' })).toBeFocused()

  await page.setViewportSize({ width: 900, height: 620 })
  await expect(crmRecord).toBeHidden()
  await expect(conversationActions).toBeVisible()
  await page.screenshot({ path: join(visualDirectory, 'warish-black-900x620.png'), animations: 'disabled' })
  await conversationHeader.locator('.conversation-identity').click()
  await expect(crmRecord).toBeVisible()
  await expect(crmRecord.getByRole('button', { name: 'Close customer details' })).toBeVisible()
  const narrowCustomerDrawer = page.locator('.persistent-contact-panel.details-overlay-open')
  await expect(narrowCustomerDrawer).toHaveCount(1)
  await crmRecord.getByRole('button', { name: 'Close customer details' }).click()
  await expect.poll(async () => {
    if (await narrowCustomerDrawer.count() === 0) return true
    return await narrowCustomerDrawer.locator('..').getAttribute('data-motion-state') === 'exiting'
  }).toBe(true)
  await expect(narrowCustomerDrawer).toHaveCount(0)
  await page.getByRole('button', { name: 'Chats', exact: true }).click()

  await page.getByRole('button', { name: 'Relink account' }).click()
  await expect(page.getByRole('dialog', { name: 'Relink WhatsApp' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'WhatsApp linked-device QR code' })).not.toBeVisible()
  await page.getByRole('button', { name: 'Close relink dialog' }).click()
})

test('filters direct chats by exact CRM stage while keeping the open conversation', async () => {
  test.setTimeout(90_000)
  await application.close()
  const database = new DatabaseSync(join(userDataPath, 'warish.sqlite'))
  database.prepare("UPDATE accounts SET linked_at=? WHERE id='primary'").run(Date.now())
  const identity = database.prepare(`INSERT INTO contact_identities(
    identity_id, phone_jid, phone_number, saved_name, whatsapp_name, avatar_failures, updated_at
  ) VALUES (?, ?, ?, ?, ?, 0, ?)`)
  const alias = database.prepare('INSERT INTO contact_identity_aliases(alias_id, identity_id, updated_at) VALUES (?, ?, ?)')
  const chat = database.prepare(`INSERT INTO chats(
    id, account_id, title, kind, last_message, last_message_at, last_message_id, unread_count, archived, pinned, updated_at
  ) VALUES (?, 'primary', ?, 'direct', ?, ?, ?, 0, 0, 0, ?)`)
  const crm = database.prepare(`INSERT INTO crm_contacts(
    id, identity_id, chat_id, lifecycle, stage_id, name, source, created_at, last_activity_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'fixture', ?, ?, ?)`)
  const fixtures = [
    { key: 'new', name: 'New Prospect', stageId: 'stage-new', lifecycle: 'lead' },
    { key: 'qualified', name: 'Qualified Prospect', stageId: 'stage-qualified', lifecycle: 'lead' },
    { key: 'quoted', name: 'Quoted Prospect', stageId: 'stage-quoted', lifecycle: 'lead' },
    { key: 'won', name: 'Won Prospect', stageId: 'stage-won', lifecycle: 'customer' },
    { key: 'lost', name: 'Lost Prospect', stageId: 'stage-lost', lifecycle: 'lead' },
    { key: 'untracked', name: 'Untracked Prospect' }
  ] as const
  const baseTime = Date.now() - 10_000
  database.exec('BEGIN')
  for (const [index, fixture] of fixtures.entries()) {
    const sequence = String(index + 1).padStart(2, '0')
    const identityId = `stage-filter-${fixture.key}`
    const phone = `155520000${sequence}`
    const chatId = `${phone}@s.whatsapp.net`
    const timestamp = baseTime + index
    identity.run(identityId, chatId, phone, fixture.name, fixture.name, timestamp)
    alias.run(chatId, identityId, timestamp)
    chat.run(chatId, fixture.name, `${fixture.name} preview`, timestamp, `stage-filter-message-${fixture.key}`, timestamp)
    if ('stageId' in fixture) {
      crm.run(`crm-stage-filter-${fixture.key}`, identityId, chatId, fixture.lifecycle, fixture.stageId,
        fixture.name, timestamp, timestamp, timestamp)
    }
  }
  database.exec('COMMIT')
  database.close()

  application = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${userDataPath}`],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  })
  page = await application.firstWindow()

  const chatList = page.locator('.chat-list')
  const stageFilter = page.getByRole('button', { name: /Filter chats by stage/ })
  const conversationHeader = page.locator('.conversation-header')
  const expectChatNames = async (visible: string[], hidden: string[]): Promise<void> => {
    for (const name of visible) await expect(chatList.getByRole('button', { name: new RegExp(name) })).toBeVisible()
    for (const name of hidden) await expect(chatList.getByRole('button', { name: new RegExp(name) })).toHaveCount(0)
  }
  const selectStage = async (name: 'All' | 'New enquiry' | 'Qualified' | 'Quoted' | 'Won' | 'Lost'): Promise<void> => {
    await stageFilter.click()
    await page.getByRole('option', { name, exact: true }).click()
    await expect(stageFilter).toContainText(name)
  }

  await expect(stageFilter).toBeVisible()
  await expectChatNames(fixtures.map((fixture) => fixture.name), [])
  await stageFilter.click()
  await expect(page.getByRole('option')).toHaveText(['All', 'New enquiry', 'Qualified', 'Quoted', 'Won', 'Lost'])
  for (const [name, color] of [
    ['New enquiry', 'rgb(245, 158, 11)'],
    ['Qualified', 'rgb(234, 179, 8)'],
    ['Quoted', 'rgb(139, 92, 246)'],
    ['Won', 'rgb(132, 204, 22)'],
    ['Lost', 'rgb(239, 68, 68)']
  ] as const) {
    const swatch = page.getByRole('option', { name, exact: true }).locator('.ui-choice-swatch')
    await expect(swatch).toBeVisible()
    expect(await swatch.evaluate((element: unknown) => {
      const target = element as BrowserColorElement
      return target.ownerDocument.defaultView.getComputedStyle(target).backgroundColor
    })).toBe(color)
  }
  const allOptionColor = await page.getByRole('option', { name: 'All', exact: true }).locator('.ui-choice-swatch')
    .evaluate((element: unknown) => {
      const target = element as BrowserColorElement
      return target.ownerDocument.defaultView.getComputedStyle(target).backgroundColor
    })
  await page.keyboard.press('Escape')
  expect(await stageFilter.locator('.ui-choice-swatch').evaluate((element: unknown) => {
    const target = element as BrowserColorElement
    return target.ownerDocument.defaultView.getComputedStyle(target).backgroundColor
  })).toBe(allOptionColor)

  const excludedFromNew = ['Qualified Prospect', 'Quoted Prospect', 'Won Prospect', 'Lost Prospect', 'Untracked Prospect']
  await selectStage('New enquiry')
  await expectChatNames(['New Prospect'], excludedFromNew)
  await selectStage('Qualified')
  await expectChatNames(['Qualified Prospect'], fixtures.filter((fixture) => fixture.key !== 'qualified').map((fixture) => fixture.name))
  await selectStage('Quoted')
  await expectChatNames(['Quoted Prospect'], fixtures.filter((fixture) => fixture.key !== 'quoted').map((fixture) => fixture.name))
  await selectStage('Won')
  await expectChatNames(['Won Prospect'], fixtures.filter((fixture) => fixture.key !== 'won').map((fixture) => fixture.name))
  expect(await stageFilter.locator('.ui-choice-swatch').evaluate((element: unknown) => {
    const target = element as BrowserColorElement
    return target.ownerDocument.defaultView.getComputedStyle(target).backgroundColor
  })).toBe('rgb(132, 204, 22)')
  await selectStage('Lost')
  await expectChatNames(['Lost Prospect'], fixtures.filter((fixture) => fixture.key !== 'lost').map((fixture) => fixture.name))
  await selectStage('All')
  await expectChatNames(fixtures.map((fixture) => fixture.name), [])

  await chatList.getByRole('button', { name: /Qualified Prospect/ }).click()
  await expect(conversationHeader.getByText('Qualified Prospect', { exact: true })).toBeVisible()
  await selectStage('New enquiry')
  await expectChatNames(['New Prospect'], excludedFromNew)
  await expect(conversationHeader.getByText('Qualified Prospect', { exact: true })).toBeVisible()

  const lifecycle = page.getByRole('region', { name: 'Sales lifecycle' })
  await lifecycle.getByRole('button', { name: 'Set sales stage to New enquiry' }).click()
  await expectChatNames(['New Prospect', 'Qualified Prospect'], ['Quoted Prospect', 'Won Prospect', 'Lost Prospect', 'Untracked Prospect'])
  await lifecycle.getByRole('button', { name: 'Set sales stage to Qualified' }).click()
  await expectChatNames(['New Prospect'], excludedFromNew)
  await expect(conversationHeader.getByText('Qualified Prospect', { exact: true })).toBeVisible()

  await selectStage('Lost')
  await page.getByRole('button', { name: 'Groups', exact: true }).click()
  await expect(page.getByRole('button', { name: /Filter chats by stage/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Chats', exact: true }).click()
  await expect(stageFilter).toContainText('Lost')
  await expectChatNames(['Lost Prospect'], fixtures.filter((fixture) => fixture.key !== 'lost').map((fixture) => fixture.name))

  await page.setViewportSize({ width: 900, height: 620 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Salesforce black' }).click()
  await page.getByRole('button', { name: 'Ultra dense' }).click()
  await page.getByRole('button', { name: 'Close settings' }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('salesforce-black')
  await expect.poll(() => page.locator('html').getAttribute('data-density-mode')).toBe('ultra-dense')
  const [headerBounds, headingBounds, filterBounds, menuBounds] = await Promise.all([
    page.locator('.panel-header').boundingBox(), page.locator('.panel-header h1').boundingBox(),
    stageFilter.boundingBox(), page.getByRole('button', { name: 'Chat list menu' }).boundingBox()
  ])
  if (!headerBounds || !headingBounds || !filterBounds || !menuBounds) throw new Error('The narrow Chats header has missing geometry')
  expect(filterBounds.x).toBeGreaterThanOrEqual(headingBounds.x + headingBounds.width - 1)
  expect(menuBounds.x).toBeGreaterThanOrEqual(filterBounds.x + filterBounds.width - 1)
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(headerBounds.x + headerBounds.width + 1)
})

test('keeps grouped replies and remote/downloaded media visually stable', async () => {
  await application.close()
  const cachedToken = 'fixture-image.png'
  mkdirSync(join(userDataPath, 'media'), { recursive: true })
  writeFileSync(join(userDataPath, 'media', cachedToken), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64'
  ))
  const thumbnail = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='
  const chatId = '15550009999@s.whatsapp.net'
  const database = new DatabaseSync(join(userDataPath, 'warish.sqlite'))
  database.prepare("UPDATE accounts SET linked_at=? WHERE id='primary'").run(Date.now())
  database.exec(`
    INSERT INTO contact_identities(identity_id, phone_jid, phone_number, saved_name, whatsapp_name, avatar_failures, updated_at)
      VALUES ('media-contact', '${chatId}', '15550009999', 'Media Review', 'Profile name', 0, 1);
    INSERT INTO contact_identity_aliases(alias_id, identity_id, updated_at)
      VALUES ('${chatId}', 'media-contact', 1);
    INSERT INTO chats(id, account_id, title, kind, last_message, last_message_at, last_message_id, unread_count, archived, pinned, updated_at)
      VALUES ('${chatId}', 'primary', 'Media Review', 'direct', 'Compact reply', 1784390180000, 'reply-message', 0, 0, 0, 1784390180000);
    INSERT INTO messages(id, account_id, chat_id, sender_id, sender_name, from_me, kind, text, timestamp, status, updated_at)
      VALUES ('group-first', 'primary', '${chatId}', '${chatId}', 'Media Review', 0, 'text', 'First grouped message with a deliberately long quoted preview', 1784390000000, 'read', 1),
             ('remote-media', 'primary', '${chatId}', '${chatId}', 'Media Review', 0, 'image', NULL, 1784390060000, 'read', 1),
             ('cached-media', 'primary', '${chatId}', '${chatId}', 'Media Review', 0, 'image', NULL, 1784390120000, 'read', 1),
             ('later-single', 'primary', '${chatId}', '${chatId}', 'Media Review', 0, 'text', 'Standalone follow-up', 1784390600000, 'read', 1);
    INSERT INTO messages(id, account_id, chat_id, sender_id, sender_name, from_me, kind, text, timestamp, status,
      quoted_message_id, quoted_sender_name, quoted_from_me, quoted_kind, quoted_text, updated_at)
      VALUES ('reply-message', 'primary', '${chatId}', '${chatId}', 'Media Review', 0, 'text', 'Compact reply', 1784390180000, 'read',
        'group-first', 'Media Review', 0, 'text', 'First grouped message with a deliberately long quoted preview', 1);
    INSERT INTO attachments(id, message_id, kind, width, height, thumbnail_data_url, cache_token, download_state)
      VALUES ('attachment:remote-media', 'remote-media', 'image', 1200, 800, '${thumbnail}', NULL, 'remote'),
             ('attachment:cached-media', 'cached-media', 'image', 1200, 800, '${thumbnail}', '${cachedToken}', 'ready');
  `)
  database.close()

  application = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${userDataPath}`],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  })
  page = await application.firstWindow()
  await page.locator('.chat-list').getByRole('button', { name: /Media Review/ }).click()

  const frames = page.locator('.media-frame')
  await expect(frames).toHaveCount(2)
  const sizes = await frames.evaluateAll((elements: unknown[]) => elements.map((element: unknown) => {
    const box = (element as BrowserBoxElement).getBoundingClientRect()
    return { width: Math.round(box.width), height: Math.round(box.height) }
  }))
  expect(sizes).toHaveLength(2)
  expect(sizes[0]).toEqual(sizes[1])
  for (const size of sizes) {
    expect(size.width).toBeGreaterThanOrEqual(280)
    expect(size.width).toBeLessThanOrEqual(320)
    expect(Math.abs(size.width / size.height - 1.5)).toBeLessThan(0.02)
  }
  await expect(page.getByRole('button', { name: 'Download Photo' })).toBeVisible()
  await expect(frames.nth(1).locator('.message-image')).toBeVisible()
  await expect(page.locator('.message-item.group-first')).toHaveCount(1)
  await expect(page.locator('.message-item.group-middle')).toHaveCount(2)
  await expect(page.locator('.message-item.group-last')).toHaveCount(1)
  await expect(page.locator('.message-item.group-single')).toHaveCount(1)
  const groupedMiddleBox = await page.locator('.message-item.group-middle').last().locator('.message-bubble').boundingBox()
  const groupedLastBox = await page.locator('.message-item.group-last .message-bubble').boundingBox()
  const standaloneBox = await page.locator('.message-item.group-single .message-bubble').boundingBox()
  if (!groupedMiddleBox || !groupedLastBox || !standaloneBox) {
    throw new Error('The grouped message spacing test has missing geometry')
  }
  const withinGroupGap = groupedLastBox.y - (groupedMiddleBox.y + groupedMiddleBox.height)
  const standaloneGap = standaloneBox.y - (groupedLastBox.y + groupedLastBox.height)
  expect(withinGroupGap).toBeGreaterThanOrEqual(0)
  expect(standaloneGap).toBeGreaterThanOrEqual(0)
  expect(Math.abs(withinGroupGap - standaloneGap)).toBeLessThanOrEqual(1)
  const quote = page.locator('.quoted-message')
  await expect(quote).toContainText('First grouped message with a deliberately long quoted preview')
  await expect(quote.locator('span')).toHaveCSS('white-space', 'nowrap')
})

test('stages, edits, and restores an ordered pasted-image album draft', async () => {
  await application.close()
  const chatId = '15550008888@s.whatsapp.net'
  const database = new DatabaseSync(join(userDataPath, 'warish.sqlite'))
  database.prepare("UPDATE accounts SET linked_at=? WHERE id='primary'").run(Date.now())
  database.exec(`
    INSERT INTO contact_identities(identity_id, phone_jid, phone_number, saved_name, whatsapp_name, avatar_failures, updated_at)
      VALUES ('clipboard-contact', '${chatId}', '15550008888', 'Clipboard Paste', 'Clipboard Profile', 0, 1);
    INSERT INTO contact_identity_aliases(alias_id, identity_id, updated_at)
      VALUES ('${chatId}', 'clipboard-contact', 1);
    INSERT INTO chats(id, account_id, title, kind, last_message, last_message_at, last_message_id, unread_count, archived, pinned, updated_at)
      VALUES ('${chatId}', 'primary', 'Clipboard Paste', 'direct', 'Ready for an image', 1784390800000, 'clipboard-seed', 0, 0, 0, 1784390800000);
    INSERT INTO messages(id, account_id, chat_id, sender_id, sender_name, from_me, kind, text, timestamp, status, updated_at)
      VALUES ('clipboard-seed', 'primary', '${chatId}', '${chatId}', 'Clipboard Paste', 0, 'text', 'Ready for an image', 1784390800000, 'read', 1);
  `)
  database.close()

  application = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${userDataPath}`],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  })
  page = await application.firstWindow()
  await page.locator('.chat-list').getByRole('button', { name: /Clipboard Paste/ }).click()
  const composer = page.getByRole('textbox', { name: 'Message' })
  await composer.fill('Image caption')
  await composer.evaluate((element, images) => {
    const target = element as unknown as BrowserClipboardElement
    const browser = target.ownerDocument.defaultView
    const transfer = new browser.DataTransfer()
    for (const image of images) {
      const binary = browser.atob(image.data)
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
      transfer.items.add(new browser.File([bytes], image.name, { type: image.type }))
    }
    target.dispatchEvent(new browser.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
  }, [
    { name: 'first.png', type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=' },
    { name: 'second.gif', type: 'image/gif', data: 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==' },
    { name: 'third.jpg', type: 'image/jpeg', data: '/9j/2Q==' }
  ])

  const imageList = page.getByRole('list', { name: '3 selected images' })
  await expect(imageList).toBeVisible()
  await expect(imageList.getByRole('img')).toHaveCount(3)
  await expect(imageList.getByRole('img').nth(0)).toHaveAttribute('alt', 'Pasted image.png preview')
  await expect(imageList.getByRole('img').nth(1)).toHaveAttribute('alt', 'Pasted image.gif preview')
  await expect(imageList.getByRole('img').nth(2)).toHaveAttribute('alt', 'Pasted image.jpg preview')
  await expect(composer).toHaveValue('Image caption')
  await expect(page.getByText('3 images selected')).toBeVisible()

  await page.getByRole('button', { name: 'Remove Pasted image.gif, image 2 of 3' }).click()
  const editedList = page.getByRole('list', { name: '2 selected images' })
  await expect(editedList.getByRole('img')).toHaveCount(2)
  await expect(editedList.getByRole('img').nth(0)).toHaveAttribute('alt', 'Pasted image.png preview')
  await expect(editedList.getByRole('img').nth(1)).toHaveAttribute('alt', 'Pasted image.jpg preview')

  let draftTokens: string[] = []
  await expect.poll(() => {
    const draftDatabase = new DatabaseSync(join(userDataPath, 'warish.sqlite'))
    const row = draftDatabase.prepare('SELECT text FROM drafts WHERE chat_id=?').get(chatId) as { text: string } | undefined
    const attachments = draftDatabase.prepare(
      'SELECT token, name, position FROM draft_attachments WHERE chat_id=? ORDER BY position'
    ).all(chatId) as Array<{ token: string; name: string; position: number }>
    draftDatabase.close()
    draftTokens = attachments.map((attachment) => attachment.token)
    return { text: row?.text, names: attachments.map((attachment) => attachment.name),
      positions: attachments.map((attachment) => attachment.position) }
  }).toEqual({ text: 'Image caption', names: ['Pasted image.png', 'Pasted image.jpg'], positions: [0, 1] })
  expect(draftTokens).toHaveLength(2)
  for (const token of draftTokens) expect(existsSync(join(userDataPath, 'drafts', token))).toBe(true)

  await application.close()
  application = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${userDataPath}`],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  })
  page = await application.firstWindow()
  await page.locator('.chat-list').getByRole('button', { name: /Clipboard Paste/ }).click()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Image caption')
  const restoredList = page.getByRole('list', { name: '2 selected images' })
  await expect(restoredList.getByRole('img').nth(0)).toHaveAttribute('alt', 'Pasted image.png preview')
  await expect(restoredList.getByRole('img').nth(1)).toHaveAttribute('alt', 'Pasted image.jpg preview')
  const stripBounds = await restoredList.boundingBox()
  const contextBounds = await page.locator('.composer-context').boundingBox()
  if (!stripBounds || !contextBounds) throw new Error('The dense album preview has no visible geometry')
  expect(stripBounds.x).toBeGreaterThanOrEqual(contextBounds.x)
  expect(stripBounds.x + stripBounds.width).toBeLessThanOrEqual(contextBounds.x + contextBounds.width + 1)

  await page.getByRole('button', { name: 'Clear reply or attachment' }).click()
  await expect(page.getByRole('list', { name: '2 selected images' })).toHaveCount(0)
  for (const token of draftTokens) await expect.poll(() => existsSync(join(userDataPath, 'drafts', token))).toBe(false)
  await expect.poll(() => {
    const draftDatabase = new DatabaseSync(join(userDataPath, 'warish.sqlite'))
    const row = draftDatabase.prepare('SELECT text, attachment_token FROM drafts WHERE chat_id=?').get(chatId) as
      { text: string; attachment_token: string | null } | undefined
    const attachmentCount = (draftDatabase.prepare('SELECT COUNT(*) AS count FROM draft_attachments WHERE chat_id=?')
      .get(chatId) as { count: number }).count
    draftDatabase.close()
    return { ...row, attachmentCount }
  }).toEqual({ text: 'Image caption', attachment_token: null, attachmentCount: 0 })

  await page.getByRole('textbox', { name: 'Message' }).evaluate((element) => {
    const target = element as unknown as BrowserClipboardElement
    const browser = target.ownerDocument.defaultView
    const bytes = Uint8Array.from(browser.atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='),
      (character) => character.charCodeAt(0))
    const transfer = new browser.DataTransfer()
    for (let index = 0; index < 31; index += 1) {
      transfer.items.add(new browser.File([bytes], `${index}.png`, { type: 'image/png' }))
    }
    target.dispatchEvent(new browser.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
  })
  await expect(page.getByText('WhatsApp albums are limited to 30 images.')).toBeVisible()
  await expect(page.locator('.composer-image-item')).toHaveCount(0)
})
