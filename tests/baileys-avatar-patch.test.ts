import { describe, expect, it, vi } from 'vitest'
import { buildProfilePictureQueryContent } from '../node_modules/@whiskeysockets/baileys/lib/Socket/chats.js'
import { buildTcTokenFromJid } from '../node_modules/@whiskeysockets/baileys/lib/Utils/tc-token-utils.js'

describe('Baileys profile-picture patch', () => {
  it('nests the trusted-contact token inside the picture query', () => {
    const token = { tag: 'tctoken', attrs: { t: '1770000000' }, content: Buffer.from([4, 1, 33]) }
    expect(buildProfilePictureQueryContent('preview', [token])).toEqual([{
      tag: 'picture', attrs: { type: 'preview', query: 'url' }, content: [token]
    }])
  })

  it('includes the trusted-contact token timestamp required by WhatsApp', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const token = Buffer.from([8, 6, 7, 5, 3, 0, 9])
    const keys = {
      get: vi.fn().mockResolvedValue({ '15550008888@s.whatsapp.net': { token, timestamp } }),
      set: vi.fn()
    }
    const result = await buildTcTokenFromJid({
      authState: { keys } as never,
      jid: '15550008888@s.whatsapp.net',
      getLIDForPN: () => Promise.resolve(null)
    })
    expect(result).toEqual([{ tag: 'tctoken', attrs: { t: timestamp }, content: token }])
  })
})
