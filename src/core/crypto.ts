import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 1
const NONCE_BYTES = 12
const TAG_BYTES = 16

export class CryptoBox {
  readonly #key: Buffer

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('WArish master key must be exactly 32 bytes')
    this.#key = Buffer.from(key)
  }

  encrypt(value: Buffer | string, associatedData?: string): Buffer {
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce)
    if (associatedData) cipher.setAAD(Buffer.from(associatedData, 'utf8'))
    const body = Buffer.concat([cipher.update(value), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([Buffer.from([VERSION]), nonce, tag, body])
  }

  decrypt(value: Uint8Array, associatedData?: string): Buffer {
    const input = Buffer.from(value)
    if (input[0] !== VERSION || input.length < 1 + NONCE_BYTES + TAG_BYTES) {
      throw new Error('Unsupported or corrupt encrypted value')
    }
    const nonce = input.subarray(1, 1 + NONCE_BYTES)
    const tag = input.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES)
    const body = input.subarray(1 + NONCE_BYTES + TAG_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', this.#key, nonce)
    if (associatedData) decipher.setAAD(Buffer.from(associatedData, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  }
}

