import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CryptoBox } from '../src/core/crypto'

describe('CryptoBox', () => {
  it('round-trips encrypted bytes with associated data', () => {
    const box = new CryptoBox(randomBytes(32))
    const encrypted = box.encrypt('private credentials', 'creds:primary')

    expect(encrypted.toString('utf8')).not.toContain('private credentials')
    expect(box.decrypt(encrypted, 'creds:primary').toString()).toBe('private credentials')
  })

  it('rejects a different associated-data context', () => {
    const box = new CryptoBox(randomBytes(32))
    const encrypted = box.encrypt('secret', 'message:one')

    expect(() => box.decrypt(encrypted, 'message:two')).toThrow()
  })

  it('requires a 256-bit key', () => {
    expect(() => new CryptoBox(randomBytes(16))).toThrow(/32 bytes/)
  })
})
