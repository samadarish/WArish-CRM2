import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

let application: ElectronApplication
let page: Page
let userDataPath: string

interface BrowserElement {
  ownerDocument: { defaultView: { getComputedStyle(target: unknown): { fontSize: string } } }
}

interface BrowserBoxElement {
  getBoundingClientRect(): { width: number; height: number }
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
  await page.getByRole('button', { name: 'black' }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('black')
  await page.getByRole('button', { name: 'comfortable' }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-density')).toBe('comfortable')
  const readableFontSize = await bodyFontSize(page)
  await page.getByRole('button', { name: 'compact' }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-density')).toBe('compact')
  expect(await bodyFontSize(page)).toBe(readableFontSize)
  await page.getByRole('button', { name: 'grid' }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-conversation-background')).toBe('grid')
  await page.getByRole('checkbox', { name: /Reduce animations/i }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-motion')).toBe('reduced')
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

test('keeps local history in the workspace when an existing account needs relinking', async () => {
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
  expect((await navigation.getByRole('button').allTextContents()).slice(0, 6)).toEqual([
    'Chats', 'Groups', 'Communities', 'Channels', 'All conversations', 'Archived'
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
  await conversationHeader.locator('.conversation-identity').click()
  const details = page.getByLabel('Conversation details')
  await expect(details.getByText('Phone number')).toBeVisible()
  await expect(details.getByText('+15550001111')).toBeVisible()
  await details.getByRole('button', { name: 'Close conversation info' }).click()
  const unsavedContact = chatList.getByRole('button', { name: /\+15550002222/ })
  await expect(unsavedContact.getByText('+15550002222')).toHaveCount(1)
  await expect(unsavedContact.locator('.whatsapp-profile-pill')).toHaveText('Profile Only')

  await page.getByRole('button', { name: 'Relink account' }).click()
  await expect(page.getByRole('dialog', { name: 'Relink WhatsApp' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'WhatsApp linked-device QR code' })).not.toBeVisible()
  await page.getByRole('button', { name: 'Close relink dialog' }).click()
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
             ('cached-media', 'primary', '${chatId}', '${chatId}', 'Media Review', 0, 'image', NULL, 1784390120000, 'read', 1);
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
  expect(sizes).toEqual([{ width: 320, height: 213 }, { width: 320, height: 213 }])
  await expect(page.getByRole('button', { name: 'Download Photo' })).toBeVisible()
  await expect(frames.nth(1).locator('.message-image')).toBeVisible()
  await expect(page.locator('.message-item.group-first')).toHaveCount(1)
  await expect(page.locator('.message-item.group-middle')).toHaveCount(2)
  await expect(page.locator('.message-item.group-last')).toHaveCount(1)
  const quote = page.locator('.quoted-message')
  await expect(quote).toContainText('First grouped message with a deliberately long quoted preview')
  await expect(quote.locator('span')).toHaveCSS('white-space', 'nowrap')
})
