import { proto, type WAMessage } from '@whiskeysockets/baileys'
import { describe, expect, it } from 'vitest'
import { isVisibleChatJid, normalizeWhatsAppMessage } from '../src/core/normalizer'

function message(content: proto.IMessage): WAMessage {
  return { key: { id: 'message-id', remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
    message: content, messageTimestamp: 1_720_000_000, pushName: 'Sender' }
}

describe('normalizeWhatsAppMessage', () => {
  it('admits channels while excluding status and broadcast control feeds', () => {
    expect(isVisibleChatJid('12345@newsletter')).toBe(true)
    expect(isVisibleChatJid('status@broadcast')).toBe(false)
    expect(isVisibleChatJid('12345@broadcast')).toBe(false)
  })

  it('ignores control envelopes instead of creating visible placeholder messages', () => {
    expect(normalizeWhatsAppMessage(message({ protocolMessage: {
      type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION
    } }))).toEqual({})
    expect(normalizeWhatsAppMessage(message({ senderKeyDistributionMessage: {} }))).toEqual({})
  })

  it('normalizes quoted text into a stable local preview', () => {
    const normalized = normalizeWhatsAppMessage(message({ extendedTextMessage: {
      text: 'The reply',
      contextInfo: { stanzaId: 'quoted-id', quotedMessage: { conversation: 'Original text' } }
    } }))

    expect(normalized.message).toMatchObject({
      kind: 'text', text: 'The reply', quotedMessageId: 'quoted-id',
      quoted: { id: 'quoted-id', kind: 'text', text: 'Original text' }
    })
  })

  it('turns product and template payloads into readable rich cards while hiding album transport parents', () => {
    const product = normalizeWhatsAppMessage(message({ productMessage: {
      product: { title: 'Desk lamp', description: 'Warm white', currencyCode: 'USD', priceAmount1000: 1299000 },
      body: 'Available now'
    } })).message
    const album = normalizeWhatsAppMessage(message({ albumMessage: { expectedImageCount: 2, expectedVideoCount: 1 } }))
    const template = normalizeWhatsAppMessage(message({ templateMessage: {
      hydratedTemplate: { hydratedTitleText: 'Order update', hydratedContentText: 'Your order has shipped', hydratedFooterText: 'Thank you' }
    } })).message

    expect(product).toMatchObject({ kind: 'rich', text: 'Desk lamp', rich: { type: 'product', title: 'Desk lamp', body: 'Available now' } })
    expect(product?.rich?.footer).toContain('$')
    expect(album).toEqual({})
    expect(template).toMatchObject({ kind: 'rich', rich: { type: 'template', title: 'Order update', body: 'Your order has shipped' } })
  })

  it('uses a friendly fallback without leaking protobuf field names', () => {
    const normalized = normalizeWhatsAppMessage(message({ secretEncryptedMessage: {} })).message
    expect(normalized).toMatchObject({ kind: 'unsupported', text: 'This message type is not supported yet' })
    expect(normalized?.text).not.toContain('secretEncryptedMessage')
  })
})
