import { describe, expect, it } from 'vitest'
import { isConfirmedAvatarMissing } from '../src/core/whatsapp-client'

describe('avatar retry classification', () => {
  it('keeps timeouts and connection errors retryable', () => {
    expect(isConfirmedAvatarMissing(new Error('Timed out waiting for message'))).toBe(false)
    expect(isConfirmedAvatarMissing(Object.assign(new Error('Connection closed'), { code: 'ECONNRESET' }))).toBe(false)
  })

  it('negative-caches only confirmed missing profile images', () => {
    expect(isConfirmedAvatarMissing({ message: 'item-not-found', output: { statusCode: 404 } })).toBe(true)
    expect(isConfirmedAvatarMissing(new Error('Profile image request failed (404)'))).toBe(true)
  })
})
