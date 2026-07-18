import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron'
import type { AppError, CoreEventEnvelope, RpcMethod, RpcRequest, RpcResponse } from '../shared/contracts'

export class CoreBridge extends EventEmitter {
  readonly #userDataPath: string
  readonly #masterKey: Buffer
  readonly #appVersion: string
  #child?: UtilityProcess
  #port?: MessagePortMain
  #pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>()
  #ready?: Promise<void>
  #intentionalStop = false

  constructor(userDataPath: string, masterKey: Buffer, appVersion: string) {
    super()
    this.#userDataPath = userDataPath
    this.#masterKey = Buffer.from(masterKey)
    this.#appVersion = appVersion
  }

  async start(): Promise<void> {
    if (this.#ready) return this.#ready
    this.#ready = new Promise<void>((resolve, reject) => {
      const corePath = join(__dirname, 'core.js')
      const child = utilityProcess.fork(corePath, [], {
        serviceName: 'WArish Core',
        env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? 'production' }
      })
      const readyTimer = setTimeout(() => {
        this.#port?.close()
        child.kill()
        reject(new Error('WArish core did not become ready in time'))
      }, 15_000)
      this.#child = child
      const { port1, port2 } = new MessageChannelMain()
      this.#port = port2
      port2.on('message', (event) => {
        const message = event.data as
          | { type: 'ready' }
          | { type: 'event'; event: CoreEventEnvelope }
          | { type: 'response'; response: RpcResponse }
        if (message.type === 'ready') { clearTimeout(readyTimer); resolve() }
        if (message.type === 'event') this.emit('event', message.event)
        if (message.type === 'response') this.#resolveResponse(message.response)
      })
      port2.start()
      child.on('exit', (code) => {
        clearTimeout(readyTimer)
        const intentional = this.#intentionalStop
        const error = new Error(intentional ? 'WArish core stopped' : `WArish core exited unexpectedly (${code})`)
        for (const pending of this.#pending.values()) pending.reject(error)
        this.#pending.clear()
        this.#port = undefined
        this.#child = undefined
        this.#ready = undefined
        if (!intentional) this.emit('exit', code)
        reject(error)
      })
      child.postMessage({
        type: 'warish:init',
        userDataPath: this.#userDataPath,
        masterKey: this.#masterKey.toString('base64'),
        appVersion: this.#appVersion,
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node
      }, [port1])
    })
    return this.#ready
  }

  async request<T = unknown>(method: RpcMethod, params: Record<string, unknown> = {}): Promise<T> {
    await this.start()
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.#port!.postMessage({ id, method, params } satisfies RpcRequest)
      const timeout = setTimeout(() => {
        if (!this.#pending.delete(id)) return
        reject(new Error(`Core request timed out: ${method}`))
      }, 30_000)
      const pending = this.#pending.get(id)!
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); pending.resolve(value) },
        reject: (error) => { clearTimeout(timeout); pending.reject(error) }
      })
    })
  }

  async stop(): Promise<void> {
    const child = this.#child
    if (!child) return
    this.#intentionalStop = true
    this.#port?.close()
    const stopped = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
    child.kill()
    await stopped
    this.#port = undefined
    this.#child = undefined
    this.#ready = undefined
    this.#intentionalStop = false
  }

  #resolveResponse(response: RpcResponse): void {
    const pending = this.#pending.get(response.id)
    if (!pending) return
    this.#pending.delete(response.id)
    if (response.ok) pending.resolve(response.data)
    else pending.reject(new WarishRpcError(response.error ?? { code: 'INTERNAL', message: 'Unknown core error', retryable: false }))
  }
}

export class WarishRpcError extends Error {
  readonly code: AppError['code']
  readonly retryable: boolean

  constructor(error: AppError) {
    super(error.message)
    this.name = 'WarishRpcError'
    this.code = error.code
    this.retryable = error.retryable
  }
}
