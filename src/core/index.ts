import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MessagePortMain } from 'electron'
import type { CoreEventEnvelope, RpcRequest, RpcResponse, SessionState } from '../shared/contracts'
import { WarishDatabase } from './database'
import { CrmRepository } from './crm-repository'
import { GoogleContactsService } from './google-contacts'
import { closeCoreLogger, createCoreLogger } from './logger'
import { MediaManager } from './media-manager'
import { RpcRouter, toAppError } from './rpc-router'
import { WhatsAppClient } from './whatsapp-client'

interface InitPayload {
  type: 'warish:init'
  userDataPath: string
  masterKey: string
  appVersion: string
  electronVersion: string
  nodeVersion: string
}

interface ParentPortEvent {
  data: InitPayload
  ports: MessagePortMain[]
}

const parent = process.parentPort as unknown as
  | { once(event: 'message', handler: (event: ParentPortEvent) => void): void }
  | undefined

if (!parent) throw new Error('WArish core must run as an Electron utility process')

parent.once('message', ({ data, ports }) => {
  try { initializeCore(data, ports) }
  catch (error) {
    // Initialization errors before the logger/renderer bridge exists must still be visible to Electron.
    console.error('WArish core initialization failed', error)
  }
})

function initializeCore(data: InitPayload, ports: MessagePortMain[]): void {
  if (data.type !== 'warish:init' || !ports[0]) throw new Error('Invalid WArish core initialization')
  const port = ports[0]
  const logDirectory = join(data.userDataPath, 'logs')
  mkdirSync(logDirectory, { recursive: true })
  const logger = createCoreLogger(logDirectory)
  const database = new WarishDatabase(join(data.userDataPath, 'warish.sqlite'), Buffer.from(data.masterKey, 'base64'), logger)
  const emit = (event: CoreEventEnvelope): void => port.postMessage({ type: 'event', event })
  const media = new MediaManager(data.userDataPath, database, logger)
  const crm = new CrmRepository(database, emit)
  const google = new GoogleContactsService(database, crm, emit)
  const whatsapp = new WhatsAppClient(database, logger, media, crm, emit)
  const router = new RpcRouter(database, whatsapp, media, crm, google, emit, logger, {
    appVersion: data.appVersion,
    electronVersion: data.electronVersion,
    nodeVersion: data.nodeVersion,
    logDirectory
  })

  port.on('message', (event) => {
    const request = event.data as RpcRequest
    void router.handle(request.method, request.params)
      .then((result) => port.postMessage({ type: 'response', response: { id: request.id, ok: true, data: result } satisfies RpcResponse }))
      .catch((error) => {
        logger.error({ error, method: request.method }, 'core request failed')
        port.postMessage({ type: 'response', response: { id: request.id, ok: false, error: toAppError(error) } satisfies RpcResponse })
      })
  })
  port.start()
  const initialization = whatsapp.initialize()
  const taskTimer = setInterval(() => {
    for (const task of crm.takeDueTaskNotifications()) emit({ type: 'crm.taskDue', payload: {
      taskId: task.id, contactId: task.contactId, title: task.title, dueAt: task.dueAt ?? task.reminderAt ?? Date.now()
    } })
  }, 30_000)
  taskTimer.unref()
  port.postMessage({ type: 'ready' })
  void initialization.catch((error) => {
    logger.error({ error }, 'WhatsApp initialization failed')
    emit({ type: 'session.changed', payload: { ...whatsapp.state, phase: 'error', message: toAppError(error).message } satisfies SessionState })
  })

  let closed = false
  const closeCore = async (): Promise<void> => {
    if (closed) return
    closed = true
    clearInterval(taskTimer)
    try { await closeCoreLogger(logger) }
    catch { /* The database still needs to close if logging is unavailable. */ }
    database.close()
  }
  process.once('beforeExit', () => { void closeCore() })
  process.once('SIGTERM', () => { void closeCore().finally(() => process.exit(0)) })
  process.once('SIGINT', () => { void closeCore().finally(() => process.exit(0)) })
}
