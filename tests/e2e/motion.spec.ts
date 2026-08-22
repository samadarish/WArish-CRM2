import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

let application: ElectronApplication
let page: Page
let userDataPath: string

interface BrowserRect { x: number; y: number; width: number; height: number; top: number; bottom: number }
interface BrowserMessageElement {
  getAttribute(name: string): string | null
  getBoundingClientRect(): BrowserRect
}
interface BrowserScrollElement {
  clientHeight: number
  scrollHeight: number
  scrollTop: number
  getBoundingClientRect(): BrowserRect
  querySelectorAll(selector: string): ArrayLike<BrowserMessageElement>
}
interface BrowserClickable { click(): void }
interface BrowserMutationObserver {
  observe(target: unknown, options: { childList: boolean; subtree: boolean; attributes?: boolean; attributeFilter?: string[] }): void
  disconnect(): void
}
interface BrowserObservedNode {
  querySelector(selector: string): BrowserObservedNode | null
}
interface BrowserObservedStyleNode extends BrowserObservedNode {
  style: { getPropertyValue(name: string): string }
}
interface BrowserObservableElement extends BrowserClickable {
  ownerDocument: {
    body: unknown
    documentElement: BrowserObservedNode & { dataset: { surfaceTransition?: string } }
    querySelector(selector: string): BrowserObservedNode | null
    querySelectorAll(selector: string): ArrayLike<BrowserObservedStyleNode>
    defaultView: {
      MutationObserver: new (callback: () => void) => BrowserMutationObserver
      getComputedStyle(target: unknown, pseudoElement?: string): { animationName: string; viewTransitionName: string }
      setTimeout(callback: () => void, delay: number): number
    }
  }
}
interface BrowserSearchInput {
  value: string
  dispatchEvent(event: unknown): boolean
  ownerDocument: {
    body: unknown
    querySelectorAll(selector: string): ArrayLike<BrowserObservedStyleNode>
    defaultView: {
      Event: new (type: string, init: { bubbles: boolean }) => unknown
      MutationObserver: new (callback: () => void) => BrowserMutationObserver
      setTimeout(callback: () => void, delay: number): number
    }
  }
}
interface BrowserRapidRow extends BrowserClickable {
  matches(selector: string): boolean
  querySelector(selector: string): { textContent: string | null } | null
}
interface BrowserRapidList {
  querySelectorAll(selector: string): ArrayLike<BrowserRapidRow>
  ownerDocument: {
    querySelector(selector: string): { textContent: string | null } | null
    querySelectorAll(selector: string): ArrayLike<BrowserRapidRow>
    defaultView: {
      performance: { now(): number }
      requestAnimationFrame(callback: () => void): number
    }
  }
}
interface BrowserStyledElement {
  style: { getPropertyValue(name: string): string }
  ownerDocument: {
    defaultView: {
      getComputedStyle(target: unknown): { animationName: string; outlineStyle: string; transitionProperty: string }
      matchMedia(query: string): { matches: boolean }
      warish: {
        chats: { update(chatId: string, patch: { pinned: boolean }): Promise<void> }
        settings: { update(patch: { theme?: string; density?: string }): Promise<unknown> }
      }
    }
  }
}
interface BrowserViewTransition {
  finished: Promise<unknown>
  ready: Promise<unknown>
  updateCallbackDone: Promise<unknown>
  types?: Set<string>
  skipTransition(): void
}
interface BrowserViewTransitionProbe {
  calls: number
  skips: number
  original(update: () => void): BrowserViewTransition
}
interface BrowserViewTransitionElement {
  ownerDocument: {
    startViewTransition?: (update: () => void) => BrowserViewTransition
    defaultView: { __warishMotionProbe?: BrowserViewTransitionProbe }
  }
}
interface BrowserFocusElement {
  ownerDocument: {
    activeElement?: { tagName: string; getAttribute(name: string): string | null }
  }
}

test.beforeEach(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'warish-motion-e2e-'))
  application = await launchApplication()
  page = await application.firstWindow()
})

test.afterEach(async () => {
  await application?.close()
  rmSync(userDataPath, { recursive: true, force: true })
})

async function launchApplication(): Promise<ElectronApplication> {
  return electron.launch({
    args: [resolve('.'), `--user-data-dir=${userDataPath}`],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  })
}

async function seedAndRelaunch(seed: (database: DatabaseSync) => void): Promise<void> {
  await application.close()
  const database = new DatabaseSync(join(userDataPath, 'warish.sqlite'))
  seed(database)
  database.close()
  application = await launchApplication()
  page = await application.firstWindow()
}

function linkAccount(database: DatabaseSync): void {
  database.prepare("UPDATE accounts SET linked_at=? WHERE id='primary'").run(Date.now())
}

function fixtureChatId(index: number): string {
  return `1888000${String(index).padStart(3, '0')}@s.whatsapp.net`
}

async function emitCoreEvent(event: object): Promise<void> {
  await application.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('warish:event', payload)
  }, event)
}

async function scrollToEnd(locator: ReturnType<Page['locator']>): Promise<void> {
  await locator.evaluate((element: unknown) => {
    const target = element as BrowserScrollElement
    target.scrollTop = target.scrollHeight
  })
}

async function expectInsideViewport(locator: ReturnType<Page['locator']>): Promise<void> {
  const viewport = page.viewportSize()
  const box = await locator.boundingBox()
  if (!viewport || !box) throw new Error('The element has no viewport bounds')
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)
}

async function expectMessageActionsBesideBubble(item: ReturnType<Page['locator']>, owner: 'received' | 'sent'): Promise<void> {
  const bubble = item.locator('.message-bubble')
  const actions = item.locator('.message-actions')
  const messageText = item.locator('.message-text')
  await bubble.hover()
  await expect(actions).toBeVisible()
  const [bubbleBounds, actionBounds, textBounds, scrollerBounds] = await Promise.all([
    bubble.boundingBox(), actions.boundingBox(), messageText.boundingBox(), page.locator('.message-scroller').boundingBox()
  ])
  if (!bubbleBounds || !actionBounds || !textBounds || !scrollerBounds) {
    throw new Error(`The ${owner} message action rail has missing geometry`)
  }
  const bubbleRight = bubbleBounds.x + bubbleBounds.width
  const actionRight = actionBounds.x + actionBounds.width
  const textRight = textBounds.x + textBounds.width
  const textBottom = textBounds.y + textBounds.height
  const actionBottom = actionBounds.y + actionBounds.height
  if (owner === 'received') expect(actionBounds.x).toBeGreaterThanOrEqual(bubbleRight)
  else expect(actionRight).toBeLessThanOrEqual(bubbleBounds.x)
  expect(Math.abs(actionBounds.y - bubbleBounds.y)).toBeLessThanOrEqual(2)
  expect(actionBounds.x < textRight && actionRight > textBounds.x
    && actionBounds.y < textBottom && actionBottom > textBounds.y).toBe(false)
  expect(actionBounds.x).toBeGreaterThanOrEqual(scrollerBounds.x - 1)
  expect(actionRight).toBeLessThanOrEqual(scrollerBounds.x + scrollerBounds.width + 1)
  expect(actionBounds.y).toBeGreaterThanOrEqual(scrollerBounds.y - 1)
  expect(actionBottom).toBeLessThanOrEqual(scrollerBounds.y + scrollerBounds.height + 1)

  const bridgeX = owner === 'received'
    ? (bubbleRight + actionBounds.x) / 2
    : (actionRight + bubbleBounds.x) / 2
  await page.mouse.move(bridgeX, actionBounds.y + actionBounds.height / 2)
  await expect(actions).toBeVisible()
  await page.mouse.move(actionBounds.x + actionBounds.width / 2, actionBounds.y + actionBounds.height / 2)
  await expect(actions).toBeVisible()
}

async function installViewTransitionProbe(): Promise<boolean> {
  return page.locator('html').evaluate((element: unknown) => {
    const document = (element as BrowserViewTransitionElement).ownerDocument
    const original = document.startViewTransition?.bind(document)
    if (!original) return false
    const probe: BrowserViewTransitionProbe = { calls: 0, skips: 0, original }
    document.defaultView.__warishMotionProbe = probe
    document.startViewTransition = (update) => {
      probe.calls += 1
      return original(update)
    }
    return true
  })
}

async function viewTransitionProbe(): Promise<{ calls: number; skips: number }> {
  return page.locator('html').evaluate((element: unknown) => {
    const probe = (element as BrowserViewTransitionElement).ownerDocument.defaultView.__warishMotionProbe
    return { calls: probe?.calls ?? 0, skips: probe?.skips ?? 0 }
  })
}

async function holdNextViewTransition(): Promise<void> {
  await page.locator('html').evaluate((element: unknown) => {
    const document = (element as BrowserViewTransitionElement).ownerDocument
    const probe = document.defaultView.__warishMotionProbe
    if (!probe) throw new Error('The View Transition probe is not installed')
    document.startViewTransition = () => {
      probe.calls += 1
      let resolveFinished: () => void = () => undefined
      const finished = new Promise<void>((resolve) => { resolveFinished = resolve })
      return {
        finished,
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        types: new Set<string>(),
        skipTransition: () => { probe.skips += 1; resolveFinished() }
      }
    }
  })
}

async function restoreViewTransitions(): Promise<void> {
  await page.locator('html').evaluate((element: unknown) => {
    const document = (element as BrowserViewTransitionElement).ownerDocument
    const probe = document.defaultView.__warishMotionProbe
    if (probe) document.startViewTransition = probe.original
  })
}

async function visibleMessageAnchor(scroller: ReturnType<Page['locator']>): Promise<{ id: string; offset: number }> {
  return scroller.evaluate((element: unknown) => {
    const target = element as BrowserScrollElement
    const viewport = target.getBoundingClientRect()
    const messages = Array.from(target.querySelectorAll('.message-item[data-message-id]'))
    const visible = messages.find((message) => message.getBoundingClientRect().bottom > viewport.top + 8)
    if (!visible) throw new Error('No visible message was available for scroll anchoring')
    return { id: visible.getAttribute('data-message-id') ?? '', offset: visible.getBoundingClientRect().top - viewport.top }
  })
}

async function messageViewportOffset(scroller: ReturnType<Page['locator']>, messageId: string): Promise<number> {
  return scroller.evaluate((element: unknown, id: string) => {
    const target = element as BrowserScrollElement
    const message = Array.from(target.querySelectorAll('.message-item[data-message-id]'))
      .find((candidate) => candidate.getAttribute('data-message-id') === id)
    if (!message) throw new Error(`Message ${id} was not rendered for scroll anchoring`)
    return message.getBoundingClientRect().top - target.getBoundingClientRect().top
  }, messageId)
}

async function clickAndObserveMessageSkeleton(locator: ReturnType<Page['locator']>): Promise<{
  sawSkeleton: boolean
  animationName?: string
  surfaceKey?: string
  chatSurfaceName?: string
  workspaceSurfaceName?: string
  groupAnimationName?: string
}> {
  return locator.evaluate((element: unknown) => {
    const target = element as BrowserObservableElement
    const document = target.ownerDocument
    const view = document.defaultView
    return new Promise<{ sawSkeleton: boolean; animationName?: string; surfaceKey?: string; chatSurfaceName?: string;
      workspaceSurfaceName?: string; groupAnimationName?: string }>((resolve) => {
      let sawSkeleton = false
      let animationName: string | undefined
      const capture = (): void => {
        const skeleton = document.querySelector('.message-history-skeleton')
        if (!skeleton) return
        sawSkeleton = true
        const pulse = skeleton.querySelector('i')
        if (pulse) animationName = view.getComputedStyle(pulse).animationName
      }
      capture()
      const observer = new view.MutationObserver(() => {
        capture()
      })
      observer.observe(document.body, { childList: true, subtree: true })
      target.click()
      const root = document.documentElement
      const conversation = document.querySelector('.conversation-panel')
      const workspace = document.querySelector('.chat-shell')
      const surfaceKey = root.dataset.surfaceTransition
      const chatSurfaceName = conversation ? view.getComputedStyle(conversation).viewTransitionName : undefined
      const workspaceSurfaceName = workspace ? view.getComputedStyle(workspace).viewTransitionName : undefined
      const groupAnimationName = view.getComputedStyle(root, '::view-transition-group(chat-surface)').animationName
      view.setTimeout(() => {
        observer.disconnect()
        resolve({ sawSkeleton, animationName, surfaceKey, chatSurfaceName, workspaceSurfaceName, groupAnimationName })
      }, 180)
    })
  })
}

async function searchAndObserveSidebarEntrances(locator: ReturnType<Page['locator']>, query: string): Promise<number> {
  return locator.evaluate((element: unknown, searchQuery: string) => {
    const target = element as BrowserSearchInput
    const document = target.ownerDocument
    const view = document.defaultView
    return new Promise<number>((resolve) => {
      let maximumEnteringRows = 0
      const capture = (): void => {
        maximumEnteringRows = Math.max(maximumEnteringRows, document.querySelectorAll('.chat-row-enter').length)
      }
      const observer = new view.MutationObserver(capture)
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
      target.value = searchQuery
      target.dispatchEvent(new view.Event('input', { bubbles: true }))
      view.setTimeout(() => {
        observer.disconnect()
        resolve(maximumEnteringRows)
      }, 650)
    })
  }, query)
}

async function clickAndObserveSidebarReveal(locator: ReturnType<Page['locator']>): Promise<{
  sawSkeleton: boolean; delays: string[]
}> {
  return locator.evaluate((element: unknown) => {
    const target = element as BrowserObservableElement
    const document = target.ownerDocument
    const view = document.defaultView
    return new Promise<{ sawSkeleton: boolean; delays: string[] }>((resolve) => {
      let sawSkeleton = false
      let delays: string[] = []
      const capture = (): void => {
        if (document.querySelector('.skeleton-list')) sawSkeleton = true
        const rows = Array.from(document.querySelectorAll('.chat-row-enter'))
        if (rows.length) delays = rows.map((row) => row.style.getPropertyValue('--row-enter-delay'))
      }
      capture()
      const observer = new view.MutationObserver(capture)
      observer.observe(document.body, { childList: true, subtree: true })
      target.click()
      view.setTimeout(() => {
        observer.disconnect()
        resolve({ sawSkeleton, delays })
      }, 350)
    })
  })
}

test('opens at the first unseen message and returns to a read chat at the newest message', async () => {
  await seedAndRelaunch((database) => {
    linkAccount(database)
    const chat = database.prepare(`INSERT INTO chats(
      id, account_id, title, kind, last_message, last_message_at, last_message_id, unread_count, archived, pinned, updated_at
    ) VALUES (?, 'primary', ?, 'direct', ?, ?, ?, ?, 0, 0, ?)`)
    const identity = database.prepare(`INSERT INTO contact_identities(
      identity_id, phone_jid, phone_number, saved_name, whatsapp_name, avatar_failures, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?)`)
    const alias = database.prepare('INSERT INTO contact_identity_aliases(alias_id, identity_id, updated_at) VALUES (?, ?, ?)')
    const message = database.prepare(`INSERT INTO messages(
      id, account_id, chat_id, sender_id, sender_name, from_me, kind, text, timestamp, status, updated_at
    ) VALUES (?, 'primary', ?, ?, ?, ?, 'text', ?, ?, 'read', ?)`)
    const baseTime = Date.now() - 500_000
    const targetChatId = fixtureChatId(201)
    const controlChatId = fixtureChatId(202)
    database.exec('BEGIN')
    identity.run('unread-target-identity', targetChatId, '1888000201', 'Unread Target', 'Unread Target', baseTime)
    identity.run('scroll-control-identity', controlChatId, '1888000202', 'Scroll Control', 'Scroll Control', baseTime)
    alias.run(targetChatId, 'unread-target-identity', baseTime)
    alias.run(controlChatId, 'scroll-control-identity', baseTime)
    chat.run(targetChatId, 'Unread Target', 'Unread history 120', baseTime + 120, 'unread-message-120', 70, baseTime + 120)
    chat.run(controlChatId, 'Scroll Control', 'Control message', baseTime + 100, 'control-message', 0, baseTime + 100)
    for (let index = 1; index <= 120; index += 1) {
      const sequence = String(index).padStart(3, '0')
      const timestamp = baseTime + index
      const fromMe = index % 4 === 0
      message.run(`unread-message-${sequence}`, targetChatId, targetChatId, 'Unread Target', Number(fromMe),
        index === 26 ? `Unread history ${sequence}\nA multiline message before the unread boundary verifies measured row heights.`
          : `Unread history ${sequence}`, timestamp, timestamp)
    }
    message.run('control-message', controlChatId, controlChatId, 'Scroll Control', 0, 'Control message',
      baseTime + 100, baseTime + 100)
    database.exec('COMMIT')
  })
  await page.setViewportSize({ width: 1366, height: 768 })
  await expect(page.locator('.conversation-identity > span > strong')).toHaveText('Unread Target')
  const chatList = page.locator('.chat-list')
  const targetRow = chatList.getByRole('button', { name: /Unread Target/ })
  const controlRow = chatList.getByRole('button', { name: /Scroll Control/ })

  await expect(page.locator('.message-history-skeleton')).toBeHidden()
  await expect(targetRow.locator('.chat-row-meta > b')).toHaveCount(0)
  const scroller = page.locator('.message-scroller')
  const firstUnread = page.locator('[data-message-id="unread-message-027"]')
  await expect(firstUnread).toBeVisible()
  await expect.poll(() => messageViewportOffset(scroller, 'unread-message-027')).toBeGreaterThanOrEqual(12)
  await expect.poll(() => messageViewportOffset(scroller, 'unread-message-027')).toBeLessThanOrEqual(64)

  await controlRow.click()
  await expect(page.locator('.conversation-identity > span > strong')).toHaveText('Scroll Control')
  await targetRow.click()
  await expect(page.locator('.conversation-identity > span > strong')).toHaveText('Unread Target')
  await expect(page.locator('.message-history-skeleton')).toBeHidden()
  await expect(page.locator('[data-message-id="unread-message-120"]')).toBeVisible()
  await expect.poll(() => scroller.evaluate((element: unknown) => {
    const target = element as BrowserScrollElement
    return target.scrollHeight - target.scrollTop - target.clientHeight
  })).toBeLessThanOrEqual(2)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await controlRow.click()
    await expect(page.locator('.conversation-identity > span > strong')).toHaveText('Scroll Control')
    await targetRow.click()
    await expect(page.locator('.conversation-identity > span > strong')).toHaveText('Unread Target')
    await expect(page.locator('[data-message-id="unread-message-120"]')).toBeVisible()
    await expect.poll(() => scroller.evaluate((element: unknown) => {
      const target = element as BrowserScrollElement
      return target.scrollHeight - target.scrollTop - target.clientHeight
    })).toBeLessThanOrEqual(2)
  }
})

test('keeps latest outgoing delivery receipts in sync across the chat list and conversation', async () => {
  await seedAndRelaunch((database) => {
    linkAccount(database)
    const chat = database.prepare(`INSERT INTO chats(
      id, account_id, title, kind, last_message, last_message_at, last_message_id, unread_count, archived, pinned, updated_at
    ) VALUES (?, 'primary', ?, 'direct', ?, ?, ?, 0, 0, 0, ?)`)
    const identity = database.prepare(`INSERT INTO contact_identities(
      identity_id, phone_jid, phone_number, saved_name, whatsapp_name, avatar_failures, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?)`)
    const alias = database.prepare('INSERT INTO contact_identity_aliases(alias_id, identity_id, updated_at) VALUES (?, ?, ?)')
    const message = database.prepare(`INSERT INTO messages(
      id, account_id, chat_id, sender_id, sender_name, from_me, kind, text, timestamp, status, updated_at
    ) VALUES (?, 'primary', ?, ?, ?, ?, 'text', ?, ?, ?, ?)`)
    const now = Date.now()
    const receiptChatId = fixtureChatId(211)
    const incomingChatId = fixtureChatId(212)
    database.exec('BEGIN')
    identity.run('receipt-identity', receiptChatId, '1888000211', 'Receipt Contact', 'Receipt Contact', now)
    identity.run('incoming-identity', incomingChatId, '1888000212', 'Incoming Contact', 'Incoming Contact', now)
    alias.run(receiptChatId, 'receipt-identity', now)
    alias.run(incomingChatId, 'incoming-identity', now)
    chat.run(receiptChatId, 'Receipt Contact', 'Latest outgoing preview', now, 'receipt-latest', now)
    chat.run(incomingChatId, 'Incoming Contact', 'Latest incoming preview', now - 1_000, 'incoming-latest', now - 1_000)
    message.run('receipt-older', receiptChatId, 'me', null, 1, 'Older outgoing message', now - 2_000, 'sent', now - 2_000)
    message.run('receipt-latest', receiptChatId, 'me', null, 1, 'Latest outgoing preview', now, 'delivered', now)
    message.run('incoming-latest', incomingChatId, incomingChatId, 'Incoming Contact', 0,
      'Latest incoming preview', now - 1_000, 'read', now - 1_000)
    database.exec('COMMIT')
  })
  await page.setViewportSize({ width: 900, height: 620 })
  await page.locator('html').evaluate((element: unknown) =>
    (element as BrowserStyledElement).ownerDocument.defaultView.warish.settings.update({ density: 'ultra-dense', theme: 'light' }))
  await expect.poll(() => page.locator('html').getAttribute('data-density-mode')).toBe('ultra-dense')

  const chatList = page.locator('.chat-list')
  const receiptRow = chatList.getByRole('button', { name: /Receipt Contact/ })
  const incomingRow = chatList.getByRole('button', { name: /Incoming Contact/ })
  const rowReceipt = receiptRow.locator('.chat-delivery-receipt')
  await expect(rowReceipt).toHaveAttribute('aria-label', 'Delivered')
  await expect(incomingRow.locator('.chat-delivery-receipt')).toHaveCount(0)

  await receiptRow.click()
  await expect(page.locator('.conversation-identity > span > strong')).toHaveText('Receipt Contact')
  const latestMessage = page.locator('[data-message-id="receipt-latest"]')
  const olderMessage = page.locator('[data-message-id="receipt-older"]')
  await expect(latestMessage.locator('.delivery-receipt')).toHaveAttribute('aria-label', 'Delivered')

  await emitCoreEvent({ type: 'message.statusChanged', payload: {
    chatId: fixtureChatId(211), messageId: 'receipt-older', status: 'read'
  } })
  await expect(olderMessage.locator('.delivery-receipt')).toHaveAttribute('aria-label', 'Read')
  await expect(rowReceipt).toHaveAttribute('aria-label', 'Delivered')

  const database = new DatabaseSync(join(userDataPath, 'warish.sqlite'))
  database.prepare("UPDATE messages SET status='read', updated_at=? WHERE id='receipt-latest'").run(Date.now())
  database.close()
  await emitCoreEvent({ type: 'message.statusChanged', payload: {
    chatId: fixtureChatId(211), messageId: 'receipt-latest', status: 'read'
  } })
  const bubbleReceipt = latestMessage.locator('.delivery-receipt')
  await expect(rowReceipt).toHaveAttribute('aria-label', 'Read')
  await expect(bubbleReceipt).toHaveAttribute('aria-label', 'Read')

  const themes = [
    ['light', 'rgb(180, 83, 9)'],
    ['dark', 'rgb(255, 180, 84)'],
    ['black', 'rgb(255, 180, 84)'],
    ['salesforce-black', 'rgb(255, 180, 84)']
  ] as const
  for (const [theme, color] of themes) {
    await page.locator('html').evaluate((element: unknown, nextTheme: string) =>
      (element as BrowserStyledElement).ownerDocument.defaultView.warish.settings.update({ theme: nextTheme }), theme)
    await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe(theme)
    await expect(rowReceipt).toHaveCSS('color', color)
    await expect(bubbleReceipt).toHaveCSS('color', color)
  }

  const rowBox = await receiptRow.boundingBox()
  const receiptBox = await rowReceipt.boundingBox()
  const previewBox = await receiptRow.locator('.chat-preview-text').boundingBox()
  if (!rowBox || !receiptBox || !previewBox) throw new Error('The chat receipt preview has missing geometry')
  expect(receiptBox.width).toBe(14)
  expect(receiptBox.x).toBeGreaterThanOrEqual(rowBox.x)
  expect(receiptBox.x + receiptBox.width).toBeLessThanOrEqual(previewBox.x)
  expect(previewBox.x + previewBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width)
})

test('keeps chat and message motion meaningful under rapid updates and reduced motion', async () => {
  test.setTimeout(90_000)
  await seedAndRelaunch((database) => {
    linkAccount(database)
    const identity = database.prepare(`INSERT INTO contact_identities(
      identity_id, phone_jid, phone_number, saved_name, whatsapp_name, avatar_failures, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?)`)
    const alias = database.prepare('INSERT INTO contact_identity_aliases(alias_id, identity_id, updated_at) VALUES (?, ?, ?)')
    const chat = database.prepare(`INSERT INTO chats(
      id, account_id, title, kind, last_message, last_message_at, last_message_id, unread_count, archived, pinned, updated_at
    ) VALUES (?, 'primary', ?, 'direct', ?, ?, ?, 0, 0, 0, ?)`)
    const message = database.prepare(`INSERT INTO messages(
      id, account_id, chat_id, sender_id, sender_name, from_me, kind, text, timestamp, status, updated_at
    ) VALUES (?, 'primary', ?, ?, ?, 0, 'text', ?, ?, 'read', ?)`)
    const baseTime = Date.now() - 500_000
    database.exec('BEGIN')
    for (let index = 1; index <= 125; index += 1) {
      const sequence = String(index).padStart(3, '0')
      const chatId = fixtureChatId(index)
      const identityId = `motion-identity-${sequence}`
      const name = `Motion Chat ${sequence}`
      const timestamp = baseTime + index
      identity.run(identityId, chatId, `1888000${sequence}`, name, `${name} Profile`, timestamp)
      alias.run(chatId, identityId, timestamp)
      chat.run(chatId, name, `Seed message ${sequence}`, timestamp, `seed-${sequence}`, timestamp)
      message.run(`seed-${sequence}`, chatId, chatId, name, `Seed message ${sequence}`, timestamp, timestamp)
    }
    const targetChatId = fixtureChatId(125)
    for (let index = 1; index <= 140; index += 1) {
      const sequence = String(index).padStart(3, '0')
      const timestamp = baseTime + 1_000 + index
      message.run(`motion-message-${sequence}`, targetChatId, targetChatId, 'Motion Chat 125',
        `History message ${sequence}`, timestamp, timestamp)
    }
    database.prepare(`UPDATE chats SET last_message='History message 140', last_message_at=?,
      last_message_id='motion-message-140', updated_at=? WHERE id=?`)
      .run(baseTime + 1_140, baseTime + 1_140, targetChatId)
    database.exec('COMMIT')
  })
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(page.locator('.chat-row')).not.toHaveCount(0)
  await expect(page.locator('.conversation-identity > span > strong')).toHaveText('Motion Chat 125')
  expect(await installViewTransitionProbe()).toBe(true)
  const syncingSession = {
    phase: 'connected', accountState: 'linked',
    historySync: { state: 'running', progress: 10 }
  }
  await emitCoreEvent({ type: 'session.changed', payload: syncingSession })
  await expect(page.getByText('Syncing recent history — 10%')).toBeVisible()
  await emitCoreEvent({ type: 'session.changed', payload: {
    ...syncingSession, historySync: { state: 'running', progress: 47 }
  } })
  await expect(page.getByText('Syncing recent history — 47%')).toBeVisible()
  expect(await viewTransitionProbe()).toEqual({ calls: 0, skips: 0 })

  const chatListMenuButton = page.getByRole('button', { name: 'Chat list menu' })
  await chatListMenuButton.focus()
  const chatListTooltip = page.locator('.ui-tooltip').filter({ hasText: 'Chat list menu' })
  await expect(chatListTooltip).toBeVisible({ timeout: 500 })
  await expect(page.locator('.ui-tooltip')).toHaveCount(1)
  await expectInsideViewport(chatListTooltip)
  await page.mouse.move(800, 300)
  await chatListMenuButton.click()
  await expect(page.locator('.ui-tooltip')).toHaveCount(0)
  await expect(page.getByRole('menu', { name: 'Chat list menu' })).toBeVisible()
  await expectInsideViewport(page.locator('.ui-menu-popover'))
  await page.mouse.click(800, 300)
  await expect(page.getByRole('menu', { name: 'Chat list menu' })).toBeHidden()

  const reveal = await clickAndObserveSidebarReveal(page.getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name: 'All conversations' }))
  expect(reveal.sawSkeleton).toBe(true)
  expect(reveal.delays.length).toBeGreaterThan(0)
  expect(reveal.delays.length).toBeLessThanOrEqual(6)
  expect(reveal.delays.every((delay) => Number.parseInt(delay || '0', 10) <= 100)).toBe(true)

  const chatList = page.locator('.chat-list')
  const sidebarSearch = page.locator('.chat-list-panel .search-box input')
  expect(await searchAndObserveSidebarEntrances(sidebarSearch, 'Motion Chat 001')).toBe(0)
  await sidebarSearch.fill('')
  await expect(chatList.getByRole('button', { name: /Motion Chat 124/ })).toBeVisible()
  const uncachedRow = chatList.getByRole('button', { name: /Motion Chat 124/ })
  expect((await clickAndObserveMessageSkeleton(uncachedRow)).sawSkeleton).toBe(true)
  await expect(page.locator('.conversation-identity > span > strong')).toHaveText('Motion Chat 124')
  await expect(page.locator('.message-history-skeleton')).toBeHidden()

  const cachedRow = chatList.getByRole('button', { name: /Motion Chat 123/ })
  await cachedRow.hover()
  await page.waitForTimeout(180)
  const cachedSkeleton = await clickAndObserveMessageSkeleton(cachedRow)
  await expect(page.locator('.conversation-identity > span > strong')).toHaveText('Motion Chat 123')
  expect(cachedSkeleton.sawSkeleton).toBe(false)
  await expect(page.locator('.message-scroller').getByText('Seed message 123', { exact: true })).toBeVisible()
  expect(cachedSkeleton.surfaceKey).toBe('chat')
  expect(cachedSkeleton.chatSurfaceName).toBe('chat-surface')
  expect(cachedSkeleton.workspaceSurfaceName).toBe('none')
  expect(cachedSkeleton.groupAnimationName).toBe('none')

  const rapidResult = await chatList.evaluate((element: unknown) => {
    const target = element as BrowserRapidList
    const document = target.ownerDocument
    const view = document.defaultView
    const rows = Array.from(target.querySelectorAll('.chat-row')).slice(0, 10).reverse()
    if (rows.length < 10) return Promise.resolve({ elapsed: Number.POSITIVE_INFINITY, expected: '', settled: false,
      immediatelyActive: false, immediateActiveCount: 0 })
    for (const row of rows.slice(0, -1)) row.click()
    const finalRow = rows.at(-1)!
    const expected = finalRow.querySelector('.chat-row-top > strong')?.textContent?.trim() ?? ''
    const started = view.performance.now()
    finalRow.click()
    const immediatelyActive = finalRow.matches('.active')
    const immediateActiveCount = Array.from(document.querySelectorAll('.chat-row.active')).length
    return new Promise<{ elapsed: number; expected: string; settled: boolean; immediatelyActive: boolean;
      immediateActiveCount: number }>((resolve) => {
      const check = (): void => {
        const elapsed = view.performance.now() - started
        const actual = document.querySelector('.conversation-identity > span > strong')?.textContent?.trim()
        if (actual === expected) { resolve({ elapsed, expected, settled: true, immediatelyActive, immediateActiveCount }); return }
        if (elapsed > 1_000) { resolve({ elapsed, expected, settled: false, immediatelyActive, immediateActiveCount }); return }
        view.requestAnimationFrame(check)
      }
      check()
    })
  })
  expect(rapidResult.settled).toBe(true)
  expect(rapidResult.immediatelyActive).toBe(true)
  expect(rapidResult.immediateActiveCount).toBe(1)
  expect(rapidResult.elapsed).toBeLessThanOrEqual(250)
  await page.waitForTimeout(250)
  await expect(page.locator('.conversation-identity > span > strong')).toHaveText(rapidResult.expected)
  await expect(page.locator('.conversation-panel .message-scroller')).toHaveCount(1)
  await expect(page.locator('.conversation-panel .composer')).toHaveCount(1)
  expect(rapidResult.expected).toBe('Motion Chat 125')

  const scroller = page.locator('.message-scroller')
  await expect(page.locator('.message-history-skeleton')).toBeHidden()
  await expect(page.locator('[data-message-id="motion-message-140"]')).toBeVisible()
  await expect.poll(() => scroller.evaluate((element: unknown) => {
    const target = element as BrowserScrollElement
    return target.scrollHeight - target.scrollTop - target.clientHeight
  })).toBeLessThanOrEqual(2)
  await scroller.evaluate((element: unknown) => { (element as BrowserScrollElement).scrollTop = 0 })
  await expect(page.getByRole('button', { name: 'Load older messages' })).toBeVisible()
  await page.waitForTimeout(80)
  const anchorBefore = await visibleMessageAnchor(scroller)
  const scrollHeightBefore = await scroller.evaluate((element: unknown) => (element as BrowserScrollElement).scrollHeight)
  await page.getByRole('button', { name: 'Load older messages' }).click()
  await expect.poll(() => scroller.evaluate((element: unknown) => (element as BrowserScrollElement).scrollHeight))
    .toBeGreaterThan(scrollHeightBefore)
  await page.waitForTimeout(120)
  const anchorAfterOffset = await messageViewportOffset(scroller, anchorBefore.id)
  expect(Math.abs(anchorAfterOffset - anchorBefore.offset)).toBeLessThanOrEqual(3)
  await expect(page.locator('.message-enter')).toHaveCount(0)
  await scroller.evaluate((element: unknown) => { (element as BrowserScrollElement).scrollTop = 0 })
  await expect(page.locator('[data-message-id="motion-message-001"]')).toBeVisible()
  await scrollToEnd(scroller)
  await expect(page.locator('[data-message-id="motion-message-140"]')).toBeVisible()

  const targetChatId = fixtureChatId(125)
  const liveMessage = {
    id: 'motion-live-one', chatId: targetChatId, senderId: targetChatId, senderName: 'Motion Chat 125', fromMe: false,
    kind: 'text', text: 'Meaningful live message', timestamp: Date.now(), status: 'delivered', edited: false,
    deleted: false, reactions: []
  }
  await emitCoreEvent({ type: 'message.upserted', payload: liveMessage })
  await expect(page.locator('[data-message-id="motion-live-one"].message-enter')).toBeVisible()
  await page.waitForTimeout(240)
  await emitCoreEvent({ type: 'message.changed', payload: {
    message: { ...liveMessage, text: 'Quiet edited message', edited: true }
  } })
  await expect(page.getByText('Quiet edited message')).toBeVisible()
  await expect(page.locator('[data-message-id="motion-live-one"].message-enter')).toHaveCount(0)

  const outgoingMessage = {
    ...liveMessage, id: 'motion-local-outgoing', senderId: 'me', senderName: undefined, fromMe: true,
    text: 'Meaningful local outgoing message\nwith a second line for action placement',
    timestamp: liveMessage.timestamp + 100, status: 'queued'
  }
  await emitCoreEvent({ type: 'message.changed', payload: { message: outgoingMessage } })
  const outgoingItem = page.locator('[data-message-id="motion-local-outgoing"]')
  await expect(outgoingItem).toHaveClass(/message-enter/)
  expect(await outgoingItem.locator('.message-bubble').evaluate((element: unknown) =>
    (element as BrowserStyledElement).ownerDocument.defaultView.getComputedStyle(element).animationName))
    .toContain('motion-message-in')
  await expect(outgoingItem).not.toHaveClass(/message-enter/, { timeout: 1_500 })

  const incomingItem = page.locator('[data-message-id="motion-live-one"]')
  await expect(page.locator('.conversation-panel.has-persistent-details')).toBeVisible()
  await expect(page.locator('.persistent-contact-panel')).toBeVisible()
  for (const density of ['comfortable', 'ultra-dense'] as const) {
    await page.locator('html').evaluate((element: unknown, nextDensity: string) =>
      (element as BrowserStyledElement).ownerDocument.defaultView.warish.settings.update({ density: nextDensity }), density)
    await expect.poll(() => page.locator('html').getAttribute('data-density-mode')).toBe(density)
    await expectMessageActionsBesideBubble(incomingItem, 'received')
    await expectMessageActionsBesideBubble(outgoingItem, 'sent')
  }
  await page.locator('html').evaluate((element: unknown) =>
    (element as BrowserStyledElement).ownerDocument.defaultView.warish.settings.update({ density: 'comfortable' }))
  await expect.poll(() => page.locator('html').getAttribute('data-density-mode')).toBe('comfortable')

  await incomingItem.locator('.message-bubble').hover()
  const incomingMenuButton = incomingItem.locator('button[aria-label="More message actions"]')
  const incomingMenuButtonBounds = await incomingMenuButton.boundingBox()
  if (!incomingMenuButtonBounds) throw new Error('The received message menu trigger has missing geometry')
  await incomingMenuButton.click()
  const incomingMenu = page.locator('.ui-menu-popover').filter({
    has: page.getByRole('menuitem', { name: 'Delete message' })
  })
  await expect(incomingMenu).toBeVisible()
  await expectInsideViewport(incomingMenu)
  const incomingMenuBounds = await incomingMenu.boundingBox()
  if (!incomingMenuBounds) throw new Error('The received message menu has missing geometry')
  expect(Math.abs(incomingMenuBounds.x - incomingMenuButtonBounds.x)).toBeLessThanOrEqual(3)
  const typeToComposeComposer = page.getByRole('textbox', { name: 'Message' })
  await expect(typeToComposeComposer).toHaveValue('')
  await page.keyboard.type('x')
  await expect(typeToComposeComposer).toHaveValue('')
  await page.getByRole('menuitem', { name: 'Copy text' }).click()
  await expect(incomingMenu).toBeHidden()
  await page.keyboard.type('copied')
  await expect(typeToComposeComposer).toHaveValue('copied')
  await typeToComposeComposer.fill('')

  await outgoingItem.locator('.message-bubble').hover()
  const messageMenuButton = outgoingItem.locator('button[aria-label="More message actions"]')
  await messageMenuButton.hover()
  const messageMenuTooltip = page.locator('.ui-tooltip').filter({ hasText: 'More message actions' })
  await expect(messageMenuTooltip).toBeVisible({ timeout: 1_000 })
  const messageMenuButtonBounds = await messageMenuButton.boundingBox()
  if (!messageMenuButtonBounds) throw new Error('The message menu trigger has missing geometry')
  await messageMenuButton.click()
  await expect(messageMenuTooltip).toHaveCount(0)
  const messageMenu = page.locator('.ui-menu-popover').filter({
    has: page.getByRole('menuitem', { name: 'Delete message' })
  })
  await expect(messageMenu).toBeVisible()
  await expectInsideViewport(messageMenu)
  const messageMenuBounds = await messageMenu.boundingBox()
  if (!messageMenuBounds) throw new Error('The message menu has missing geometry')
  expect(Math.abs(messageMenuBounds.x + messageMenuBounds.width
    - (messageMenuButtonBounds.x + messageMenuButtonBounds.width))).toBeLessThanOrEqual(3)
  expect(messageMenuBounds.y + messageMenuBounds.height).toBeLessThanOrEqual(messageMenuButtonBounds.y)
  await page.getByRole('menuitem', { name: 'Delete message' }).click()
  const deleteDialog = page.getByRole('dialog', { name: 'Delete message' })
  await expect(deleteDialog).toBeVisible()
  await page.getByRole('button', { name: 'Close Delete message' }).click()
  await expect(deleteDialog).toHaveCount(0, { timeout: 1_500 })
  await expect.poll(() => page.locator('html').evaluate((element: unknown) => {
    const active = (element as BrowserFocusElement).ownerDocument.activeElement
    return { tagName: active?.tagName, label: active?.getAttribute('aria-label') }
  })).toEqual({ tagName: 'BUTTON', label: 'More message actions' })

  const batchMessages = Array.from({ length: 3 }, (_, index) => ({
    ...liveMessage, id: `motion-batch-${index}`, text: `Quiet batch ${index}`, timestamp: liveMessage.timestamp + index + 1
  }))
  await emitCoreEvent({ type: 'message.batch', payload: { messages: batchMessages } })
  await expect(page.getByText('Quiet batch 2')).toBeVisible()
  await expect(page.locator('.message-enter')).toHaveCount(0)
  const cappedMessages = Array.from({ length: 5 }, (_, index) => ({
    ...liveMessage, id: `motion-cap-${index}`, text: `Capped batch ${index}`, timestamp: liveMessage.timestamp + 10 + index
  }))
  await emitCoreEvent({ type: 'message.batch', payload: { messages: cappedMessages } })
  await expect(page.getByText('Capped batch 4')).toBeVisible()
  await expect(page.locator('.message-enter')).toHaveCount(0)

  await page.waitForTimeout(340)
  await page.locator('html').evaluate((element: unknown, chatId: string) =>
    (element as BrowserStyledElement).ownerDocument.defaultView.warish.chats.update(chatId, { pinned: true }), fixtureChatId(120))
  const pinnedRow = chatList.locator('.chat-row').first()
  await expect(pinnedRow.locator('.chat-row-top > strong')).toHaveText('Motion Chat 120')
  await expect(pinnedRow.locator('.chat-pinned-indicator')).toBeVisible()
  await expect(pinnedRow).toHaveAccessibleName(/Pinned chat/)
  await expect(page.locator('.chat-row-enter')).toHaveCount(0)

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await scrollToEnd(chatList)
    await page.waitForTimeout(180)
  }
  await expect(chatList.getByRole('button', { name: /Motion Chat 001/ })).toBeVisible()
  await chatList.evaluate((element: unknown) => { (element as BrowserScrollElement).scrollTop = 0 })

  const crmButton = page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'CRM' })
  const transitionsBeforeInterruption = await viewTransitionProbe()
  await holdNextViewTransition()
  await crmButton.click()
  await expect.poll(async () => (await viewTransitionProbe()).calls)
    .toBeGreaterThan(transitionsBeforeInterruption.calls)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  await expect.poll(async () => (await viewTransitionProbe()).skips)
    .toBeGreaterThan(transitionsBeforeInterruption.skips)
  await restoreViewTransitions()
  expect(await page.locator('html').evaluate((element: unknown) =>
    (element as BrowserStyledElement).ownerDocument.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  expect(await page.locator('.crm-workspace').evaluate((element: unknown) =>
    (element as BrowserStyledElement).ownerDocument.defaultView.getComputedStyle(element).animationName)).toBe('none')
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'Chats' }).click()
  await chatList.getByRole('button', { name: /Motion Chat 125/ }).click()
  await expect(page.locator('.conversation-identity > span > strong')).toHaveText('Motion Chat 125')
  const reducedMessage = { ...liveMessage, id: 'motion-reduced', text: 'Static reduced message', timestamp: Date.now() + 100 }
  await emitCoreEvent({ type: 'message.upserted', payload: reducedMessage })
  await expect(page.getByText('Static reduced message')).toBeVisible()
  await expect(page.locator('[data-message-id="motion-reduced"].message-enter')).toHaveCount(0)
  await crmButton.click()
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  expect(await page.locator('.crm-workspace').evaluate((element: unknown) =>
    (element as BrowserStyledElement).ownerDocument.defaultView.getComputedStyle(element).animationName)).toBe('none')
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'Chats' }).click()

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect.poll(() => page.locator('html').getAttribute('data-surface-transition')).toBeNull()
  expect(await page.locator('html').evaluate((element: unknown) =>
    (element as BrowserStyledElement).ownerDocument.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false)
  await chatList.getByRole('button', { name: /Motion Chat 125/ }).click()
  await expect(page.locator('.conversation-identity > span > strong')).toHaveText('Motion Chat 125')
  await expect(outgoingItem).toBeVisible()
  const composer = page.getByRole('textbox', { name: 'Message' })
  await outgoingItem.locator('.message-text').click({ clickCount: 3 })
  await page.keyboard.press('Control+C')
  await page.keyboard.type('selection-first')
  await expect(composer).toHaveValue('selection-first')
  await composer.fill('')
  await composer.evaluate((element: unknown) => { (element as { blur(): void }).blur() })
  await scroller.hover()
  await page.mouse.wheel(0, -240)
  await page.keyboard.type('wheel-first')
  await expect(composer).toHaveValue('wheel-first')
  await composer.fill('')
  await composer.fill('Composer focus regression')
  await composer.press('Enter')
  await expect(composer).toBeFocused()
  await expect(composer).toHaveAttribute('aria-busy', 'false')
  await page.keyboard.type('next')
  await expect(composer).toHaveValue(/next$/)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const appearanceDialog = page.getByRole('dialog', { name: 'Appearance' })
  await expect(appearanceDialog).toBeVisible()
  const disableAnimations = appearanceDialog.getByRole('checkbox', { name: /Disable animations/i })
  await expect(disableAnimations).toBeVisible()
  await disableAnimations.click()
  await expect(disableAnimations).toBeChecked()
  await expect.poll(() => page.locator('html').getAttribute('data-motion')).toBe('reduced')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'CRM' }).click()
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  expect(await page.locator('.crm-workspace').evaluate((element: unknown) =>
    (element as BrowserStyledElement).ownerDocument.defaultView.getComputedStyle(element).animationName)).toBe('none')
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'Chats' }).click()

  const staticTarget = chatList.getByRole('button', { name: /Motion Chat 115/ })
  const staticSkeleton = await clickAndObserveMessageSkeleton(staticTarget)
  expect(staticSkeleton.sawSkeleton).toBe(true)
  expect(staticSkeleton.animationName).toBe('none')
  await expect(page.locator('.conversation-identity > span > strong')).toHaveText('Motion Chat 115')

  await page.setViewportSize({ width: 900, height: 620 })
  await page.getByRole('button', { name: 'Choose an emoji' }).click()
  const emojiPicker = page.getByRole('dialog', { name: 'Choose an emoji' })
  const tooltip = page.locator('.ui-tooltip')
  await expect(emojiPicker).toBeVisible()
  await expectInsideViewport(emojiPicker)
  for (const label of ['Grinning face', 'Face with tears of joy', 'Smiling face']) {
    await emojiPicker.getByRole('button', { name: label, exact: true }).hover()
    await page.waitForTimeout(75)
  }
  await page.getByRole('textbox', { name: 'Message' }).hover()
  await page.waitForTimeout(500)
  await expect(tooltip).toHaveCount(0)

  await emojiPicker.getByRole('button', { name: 'Grinning face', exact: true }).hover()
  await expect(tooltip).toHaveText('Grinning face', { timeout: 1_000 })
  await expect(tooltip).toHaveCount(1)
  await expectInsideViewport(tooltip)
  const smilingEmoji = emojiPicker.getByRole('button', { name: 'Smiling face', exact: true })
  await smilingEmoji.hover()
  await expect(tooltip).toHaveCount(1)
  await expect(tooltip).toHaveText('Smiling face')
  await expectInsideViewport(tooltip)

  const tooltipVisualDirectory = resolve('test-results', 'visual', 'motion-tooltips')
  const tooltipThemes = ['light', 'dark', 'black', 'salesforce-black'] as const
  const tooltipDensities = ['comfortable', 'compact', 'dense', 'ultra-dense'] as const
  mkdirSync(tooltipVisualDirectory, { recursive: true })
  for (const theme of tooltipThemes) {
    for (const density of tooltipDensities) {
      await page.locator('html').evaluate((element: unknown, appearance: { theme: string; density: string }) =>
        (element as BrowserStyledElement).ownerDocument.defaultView.warish.settings.update(appearance), { theme, density })
      await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe(theme)
      await expect.poll(() => page.locator('html').getAttribute('data-density-mode')).toBe(density)
      await smilingEmoji.hover()
      await expect(tooltip).toHaveCount(1)
      await expect(tooltip).toHaveText('Smiling face')
      await expectInsideViewport(emojiPicker)
      await expectInsideViewport(tooltip)
      await page.screenshot({
        path: join(tooltipVisualDirectory, `emoji-${theme}-${density}-900x620.png`), animations: 'disabled'
      })
    }
  }
  await emojiPicker.getByRole('button', { name: 'Close emoji picker' }).click()
  await expect(emojiPicker).toBeHidden()
  await expect(tooltip).toHaveCount(0)
})

test('keeps virtual CRM records reachable and portaled choices inside every viewport', async () => {
  test.setTimeout(90_000)
  await seedAndRelaunch((database) => {
    linkAccount(database)
    const chatId = '18889990000@s.whatsapp.net'
    const now = Date.now()
    database.exec(`
      INSERT INTO contact_identities(identity_id, phone_jid, phone_number, saved_name, whatsapp_name, avatar_failures, updated_at)
        VALUES ('motion-crm-identity', '${chatId}', '18889990000', 'Motion Customer', 'Motion Customer', 0, ${now});
      INSERT INTO contact_identity_aliases(alias_id, identity_id, updated_at)
        VALUES ('${chatId}', 'motion-crm-identity', ${now});
      INSERT INTO chats(id, account_id, title, kind, last_message, last_message_at, last_message_id, unread_count, archived, pinned, updated_at)
        VALUES ('${chatId}', 'primary', 'Motion Customer', 'direct', 'CRM fixture', ${now}, NULL, 0, 0, 0, ${now});
      INSERT INTO crm_contacts(id, identity_id, chat_id, lifecycle, stage_id, name, source, created_at, last_activity_at, updated_at)
        VALUES ('motion-crm-contact', 'motion-crm-identity', '${chatId}', 'lead', 'stage-new', 'Motion Customer', 'fixture', ${now}, ${now}, ${now});
      INSERT INTO crm_catalog_items(id, type, name, sku, description, unit_price, currency, active, created_at, updated_at)
        VALUES ('motion-catalog', 'product', 'Motion Catalog Item', 'MOTION-1', 'Placement fixture', 1200, 'INR', 1, ${now}, ${now});
    `)
    const task = database.prepare(`INSERT INTO crm_tasks(
      id, contact_id, title, due_at, priority, status, created_at, updated_at
    ) VALUES (?, 'motion-crm-contact', ?, ?, 'normal', 'open', ?, ?)`)
    const order = database.prepare(`INSERT INTO crm_orders(
      id, contact_id, order_number, status, payment_status, currency, subtotal, discount, tax, total, created_at, updated_at
    ) VALUES (?, 'motion-crm-contact', ?, 'draft', 'unpaid', 'INR', 100, 0, 0, 100, ?, ?)`)
    database.exec('BEGIN')
    for (let index = 1; index <= 100; index += 1) {
      const sequence = String(index).padStart(3, '0')
      task.run(`motion-task-${sequence}`, `Task ${sequence}`, now + index, now + index, now + index)
      order.run(`motion-order-${sequence}`, `E2E-${sequence}`, now + index, now + index)
    }
    database.exec('COMMIT')
  })

  await page.setViewportSize({ width: 1366, height: 768 })
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'CRM' }).click()
  const crmNavigation = page.getByRole('navigation', { name: 'CRM sections' })
  const tasksButton = crmNavigation.getByRole('button', { name: 'Tasks' })
  const geometryBefore = await tasksButton.boundingBox()
  await tasksButton.hover()
  const geometryAfter = await tasksButton.boundingBox()
  expect(geometryBefore).not.toBeNull()
  expect(geometryAfter).not.toBeNull()
  expect(geometryAfter).toEqual(geometryBefore)
  await page.keyboard.press('Tab')
  await tasksButton.focus()
  expect(await tasksButton.evaluate((element: unknown) =>
    (element as BrowserStyledElement).ownerDocument.defaultView.getComputedStyle(element).outlineStyle)).not.toBe('none')

  await tasksButton.click()
  const taskList = page.locator('.crm-virtual-task-list')
  await expect(taskList).toBeVisible()
  await expect(taskList.locator('.crm-task').first()).toBeVisible()
  await expect.poll(() => taskList.locator('.crm-task').count()).toBeLessThan(60)
  const taskTransitionProperties = await taskList.locator('.crm-task').first().evaluate((element: unknown) =>
    (element as BrowserStyledElement).ownerDocument.defaultView.getComputedStyle(element).transitionProperty)
  const taskTransitions = taskTransitionProperties.split(',').map((property) => property.trim())
  expect(taskTransitions).not.toContain('all')
  expect(taskTransitions).not.toContain('transform')
  await scrollToEnd(taskList)
  await expect(page.getByText('Task 100', { exact: true })).toBeVisible()

  await crmNavigation.getByRole('button', { name: 'Orders' }).click()
  const orderTable = page.locator('.crm-virtual-table')
  await expect(orderTable).toBeVisible()
  await expect.poll(() => orderTable.locator('tbody tr').count()).toBeLessThan(60)
  await scrollToEnd(orderTable)
  await expect(page.getByText('E2E-001', { exact: true })).toBeVisible()

  await page.setViewportSize({ width: 1547, height: 705 })
  await page.locator('html').evaluate((element: unknown) =>
    (element as BrowserStyledElement).ownerDocument.defaultView.warish.settings.update({ density: 'ultra-dense' }))
  await expect.poll(() => page.locator('html').getAttribute('data-density-mode')).toBe('ultra-dense')
  await page.getByRole('button', { name: 'New order' }).click()
  const orderDialog = page.getByRole('dialog', { name: 'New order' })
  const orderDialogBody = orderDialog.locator('.crm-dialog-body')
  await expect(orderDialog).toBeVisible()
  await expectInsideViewport(orderDialog)
  const orderDialogOverflow = await orderDialogBody.evaluate((element: unknown) => {
    const target = element as { clientWidth: number; scrollWidth: number; clientHeight: number; scrollHeight: number }
    return { horizontal: target.scrollWidth - target.clientWidth, vertical: target.scrollHeight - target.clientHeight }
  })
  expect(orderDialogOverflow.horizontal).toBeLessThanOrEqual(1)
  expect(orderDialogOverflow.vertical).toBeLessThanOrEqual(1)
  await expect(orderDialog.getByRole('button', { name: 'Save order' })).toBeVisible()
  await orderDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(orderDialog).toBeHidden()
  await page.locator('html').evaluate((element: unknown) =>
    (element as BrowserStyledElement).ownerDocument.defaultView.warish.settings.update({ density: 'comfortable' }))
  await expect.poll(() => page.locator('html').getAttribute('data-density-mode')).toBe('comfortable')

  await tasksButton.click()
  await page.getByRole('button', { name: 'New task' }).click()
  const dialog = page.getByRole('dialog', { name: 'New follow-up' })
  await expect(dialog).toBeVisible()
  const dialogSurface = page.locator('.crm-dialog')
  const contactInput = dialog.getByRole('combobox', { name: 'Contact' })
  await contactInput.fill('missing contact')
  await expect(page.getByText('No matching options')).toBeVisible()
  await contactInput.fill('Motion')
  await expect(page.getByRole('option', { name: /Motion Customer/ })).toBeVisible()
  await page.keyboard.press('Escape')

  const visualDirectory = resolve('test-results', 'visual', 'motion-popovers')
  mkdirSync(visualDirectory, { recursive: true })
  const viewports = [{ width: 900, height: 620 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }]
  const themes = ['light', 'dark', 'black', 'salesforce-black'] as const
  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    for (const theme of themes) {
      await page.locator('html').evaluate((element: unknown, nextTheme: string) =>
        (element as BrowserStyledElement).ownerDocument.defaultView.warish.settings.update({ theme: nextTheme }), theme)
      await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe(theme)
      await dialogSurface.locator('button[aria-label="Open Contact options"]').click()
      const popover = page.locator('.ui-popover').last()
      await expect(popover).toBeVisible()
      await expect(page.getByRole('option', { name: /Motion Customer/ })).toBeVisible()
      expect(await dialogSurface.locator('.ui-popover').count()).toBe(0)
      await expectInsideViewport(popover)
      await page.screenshot({
        path: join(visualDirectory, `choice-${theme}-${viewport.width}x${viewport.height}.png`),
        animations: 'disabled'
      })
      await page.keyboard.press('Escape')
      await expect(popover).toBeHidden()
    }
    const prioritySelect = dialog.locator('.ui-select-field').filter({ hasText: 'Priority' }).locator('.ui-choice-trigger')
    await prioritySelect.click()
    const selectPopover = page.locator('.ui-popover').last()
    await expect(selectPopover).toBeVisible()
    await expect(page.getByRole('option', { name: 'Normal', exact: true })).toBeVisible()
    await expectInsideViewport(selectPopover)
    await page.keyboard.press('Escape')
    await expect(selectPopover).toBeHidden()
  }
})
