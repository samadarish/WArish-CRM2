import { mkdtempSync, rmSync } from 'node:fs'
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
  await page.getByRole('checkbox', { name: /Reduce animations/i }).check()
  await expect.poll(() => page.locator('html').getAttribute('data-motion')).toBe('reduced')
  await page.getByRole('button', { name: 'collapsed' }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-navigation')).toBe('collapsed')
  await page.getByRole('button', { name: 'auto' }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-navigation')).toBe('auto')
  await page.getByRole('button', { name: 'Messaging' }).click()
  await expect(page.getByRole('checkbox', { name: /Enter to send/i })).toBeChecked()
  await page.getByRole('checkbox', { name: /Show chat previews/i }).uncheck()
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

  await page.getByRole('button', { name: 'Relink account' }).click()
  await expect(page.getByRole('dialog', { name: 'Relink WhatsApp' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'WhatsApp linked-device QR code' })).not.toBeVisible()
  await page.getByRole('button', { name: 'Close relink dialog' }).click()
})
