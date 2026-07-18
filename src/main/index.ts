import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, protocol,
  session, shell, Tray
} from 'electron'
import { rpcInvocationSchema, type AppSettings, type ChatSummary, type CoreEventEnvelope, type MessageDto, type PickedAttachment, type SessionState } from '../shared/contracts'
import { CoreBridge } from './core-bridge'
import { loadOrCreateMasterKey } from './security'

protocol.registerSchemesAsPrivileged([{ scheme: 'warish-media', privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true } }])

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let core: CoreBridge | undefined
let isQuitting = false
let settings: AppSettings | undefined
let currentSession: SessionState = { phase: 'starting', accountState: 'never-linked' }
let resetRunning = false

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(bootstrap).catch((error) => {
    dialog.showErrorBox('WArish could not start', error instanceof Error ? error.message : String(error))
    app.quit()
  })
}

async function bootstrap(): Promise<void> {
  app.setName('WArish')
  app.setAppUserModelId('com.warish.desktop')
  const userDataPath = app.getPath('userData')
  const masterKey = loadOrCreateMasterKey(userDataPath)
  core = new CoreBridge(userDataPath, masterKey, app.getVersion())
  core.on('event', handleCoreEvent)
  core.on('exit', () => mainWindow?.webContents.send('warish:event', {
    type: 'session.changed', payload: { ...currentSession, phase: 'error', message: 'The messaging core stopped unexpectedly.' }
  } satisfies CoreEventEnvelope))
  await core.start()
  const [initialSettings, initialSession] = await Promise.all([
    core.request<AppSettings>('settings.get'), core.request<SessionState>('session.getState')
  ])
  settings = initialSettings
  currentSession = initialSession
  configureMediaProtocol(userDataPath)
  createWindow()
  createTray()
  registerIpc(userDataPath)
  configurePermissions()
  applyStartupSetting(settings.launchAtLogin)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#0b141a',
    title: 'WArish',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      devTools: !app.isPackaged
    }
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    mainWindow?.hide()
  })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect rx="8" width="32" height="32" fill="#00a884"/><path d="M7 8h4l2 12 3-8 3 8 2-12h4l-4 16h-4l-3-7-3 7H9z" fill="white"/></svg>').toString('base64')}`
  )
  tray = new Tray(icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('WArish')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open WArish', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit() } }
  ]))
  tray.on('double-click', showWindow)
}

function registerIpc(userDataPath: string): void {
  ipcMain.handle('warish:rpc', async (event, value) => {
    assertTrustedSender(event.sender)
    const invocation = rpcInvocationSchema.parse(value)
    const result = await core!.request(invocation.method, invocation.params)
    if (invocation.method === 'settings.update') {
      settings = result as AppSettings
      applyStartupSetting(settings.launchAtLogin)
    }
    return result
  })
  ipcMain.handle('warish:pick-attachment', (event) => { assertTrustedSender(event.sender); return pickAttachment(userDataPath) })
  ipcMain.handle('warish:save-recording', (event, data: unknown, mimeType: unknown) => {
    assertTrustedSender(event.sender)
    return saveRecording(userDataPath, data, mimeType)
  })
  ipcMain.handle('warish:open-media', (event, token: unknown) => {
    assertTrustedSender(event.sender)
    return openMedia(userDataPath, token)
  })
  ipcMain.handle('warish:reset-local-data', async (event) => {
    assertTrustedSender(event.sender)
    await resetLocalData(userDataPath)
  })
}

async function resetLocalData(userDataPath: string): Promise<void> {
  if (resetRunning) return
  resetRunning = true
  try {
    try { await core?.request('session.logout', { eraseLocalData: false }) }
    catch { /* Local reset must still work when WhatsApp is offline. */ }
    await core?.stop()
    await session.defaultSession.clearStorageData()
    await session.defaultSession.clearCache()
    for (const path of [
      join(userDataPath, 'warish.sqlite'),
      join(userDataPath, 'warish.sqlite-wal'),
      join(userDataPath, 'warish.sqlite-shm'),
      join(userDataPath, 'master-key.bin'),
      join(userDataPath, 'media'),
      join(userDataPath, 'drafts'),
      join(userDataPath, 'avatars'),
      join(userDataPath, 'backups'),
      join(userDataPath, 'logs')
    ]) rmSync(path, { recursive: true, force: true })
    isQuitting = true
    app.relaunch()
    app.exit(0)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('WArish reset was incomplete', `Some local data could not be removed. WArish will restart so you can try again.\n\n${message}`)
    isQuitting = true
    app.relaunch()
    app.exit(1)
    throw error
  }
}

function saveRecording(userDataPath: string, data: unknown, mimeType: unknown): PickedAttachment {
  if (!(data instanceof Uint8Array) || typeof mimeType !== 'string' || data.byteLength === 0) throw new Error('Invalid voice recording')
  if (data.byteLength > 25 * 1024 * 1024) throw new Error('Voice recordings are limited to 25 MB')
  const drafts = join(userDataPath, 'drafts')
  mkdirSync(drafts, { recursive: true })
  const extension = mimeType.includes('ogg') ? '.ogg' : '.webm'
  const token = `${randomUUID()}${extension}`
  writeFileSync(safeMediaPath(drafts, token), data)
  return { token, name: `Voice message${extension}`, size: data.byteLength, mimeType,
    previewUrl: `warish-media://drafts/${encodeURIComponent(token)}` }
}

async function pickAttachment(userDataPath: string): Promise<PickedAttachment | null> {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Choose an attachment',
    properties: ['openFile'],
    filters: [
      { name: 'Media and documents', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm', 'ogg', 'opus', 'mp3', 'm4a', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt'] },
      { name: 'All files', extensions: ['*'] }
    ]
  })
  const source = result.filePaths[0]
  if (result.canceled || !source) return null
  const drafts = join(userDataPath, 'drafts')
  mkdirSync(drafts, { recursive: true })
  const token = `${randomUUID()}${extname(source).toLowerCase()}`
  const sourceStat = await stat(source)
  if (sourceStat.size > 2 * 1024 * 1024 * 1024) throw new Error('Attachments are limited to 2 GB')
  await copyFile(source, safeMediaPath(drafts, token))
  return { token, name: basename(source), size: sourceStat.size, mimeType: mimeForPath(source),
    previewUrl: `warish-media://drafts/${encodeURIComponent(token)}` }
}

async function openMedia(userDataPath: string, token: unknown): Promise<void> {
  if (typeof token !== 'string') throw new Error('Invalid media token')
  const error = await shell.openPath(safeMediaPath(join(userDataPath, 'media'), token))
  if (error) throw new Error(error)
}

function configureMediaProtocol(userDataPath: string): void {
  protocol.handle('warish-media', (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'cache' && url.hostname !== 'drafts' && url.hostname !== 'avatars') {
      return new Response('Not found', { status: 404 })
    }
    const token = decodeURIComponent(url.pathname.slice(1))
    try {
      const directory = join(userDataPath, url.hostname === 'cache' ? 'media' : url.hostname)
      return net.fetch(pathToFileURL(safeMediaPath(directory, token)).toString())
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function configurePermissions(): void {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' && webContents === mainWindow?.webContents)
  })
  session.defaultSession.setPermissionCheckHandler((webContents, permission) =>
    permission === 'media' && webContents === mainWindow?.webContents)
}

function handleCoreEvent(event: CoreEventEnvelope): void {
  mainWindow?.webContents.send('warish:event', event)
  if (event.type === 'session.changed' && event.payload && typeof event.payload === 'object' && 'phase' in event.payload) {
    currentSession = event.payload as SessionState
  }
  if (event.type === 'settings.changed') settings = event.payload as AppSettings
  if (event.type !== 'message.upserted' || currentSession.phase !== 'connected' || mainWindow?.isFocused()) return
  const message = event.payload as MessageDto
  if (message.fromMe) return
  void showMessageNotification(message)
}

async function showMessageNotification(message: MessageDto): Promise<void> {
  let chat: ChatSummary | undefined
  try { chat = await core?.request<ChatSummary>('chat.get', { chatId: message.chatId }) }
  catch { /* A notification can still use its privacy-safe fallback. */ }
  if (chat?.kind === 'channel' || (chat?.mutedUntil && chat.mutedUntil > Date.now())) return
  const previews = settings?.notificationPreview ?? true
  const notification = new Notification({
    title: previews ? chat?.title ?? message.senderName ?? 'New WArish message' : 'WArish',
    body: previews ? message.text ?? message.kind : 'New message',
    silent: false
  })
  notification.on('click', () => {
    showWindow()
    mainWindow?.webContents.send('warish:event', { type: 'navigation.openChat', payload: { chatId: message.chatId } } satisfies CoreEventEnvelope)
  })
  notification.show()
}

function applyStartupSetting(enabled: boolean): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true, path: process.execPath })
}

function safeMediaPath(directory: string, token: string): string {
  if (basename(token) !== token) throw new Error('Invalid media token')
  const parent = resolve(directory)
  const path = resolve(directory, token)
  if (!path.startsWith(`${parent}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Invalid media path')
  return path
}

function mimeForPath(path: string): string {
  const map: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.pdf': 'application/pdf', '.txt': 'text/plain' }
  return map[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function showWindow(): void { mainWindow?.show(); mainWindow?.focus() }
function assertTrustedSender(sender: Electron.WebContents): void {
  if (sender !== mainWindow?.webContents) throw new Error('Untrusted IPC sender')
}
function isSafeExternalUrl(value: string): boolean {
  try { return ['https:', 'mailto:'].includes(new URL(value).protocol) } catch { return false }
}

app.on('before-quit', () => { isQuitting = true; void core?.stop() })
app.on('window-all-closed', () => { /* WArish intentionally remains in the tray. */ })
