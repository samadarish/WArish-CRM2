import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'

export function loadOrCreateMasterKey(userDataPath: string): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows secure storage is unavailable. WArish will not store WhatsApp credentials without encryption.')
  }
  mkdirSync(userDataPath, { recursive: true })
  const keyPath = join(userDataPath, 'master-key.bin')
  if (existsSync(keyPath)) {
    const plaintext = safeStorage.decryptString(readFileSync(keyPath))
    const key = Buffer.from(plaintext, 'base64')
    if (key.length !== 32) throw new Error('The WArish credential key is corrupt')
    return key
  }
  const key = randomBytes(32)
  writeFileSync(keyPath, safeStorage.encryptString(key.toString('base64')), { mode: 0o600 })
  return key
}

