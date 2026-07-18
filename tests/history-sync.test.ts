import { proto, type WAMessage } from '@whiskeysockets/baileys'
import { describe, expect, it } from 'vitest'
import { filterInitialHistoryMessages, shouldDownloadInitialHistoryChunk } from '../src/core/whatsapp-client'
import { isVisibleChatJid, normalizeWhatsAppMessage } from '../src/core/normalizer'

function textMessage(id: string, chatId: string, timestamp: number): WAMessage {
  return {
    key: { id, remoteJid: chatId, fromMe: false },
    messageTimestamp: Math.floor(timestamp / 1000),
    message: { conversation: id }
  }
}

describe('history synchronization filters', () => {
  it('stores only messages inside the selected initial-history window', () => {
    const cutoff = 1_800_000_000_000
    const messages = [
      textMessage('outside', '15550001111@s.whatsapp.net', cutoff - 1_000),
      textMessage('boundary', '15550001111@s.whatsapp.net', cutoff),
      textMessage('recent', '15550001111@s.whatsapp.net', cutoff + 1_000)
    ]

    expect(filterInitialHistoryMessages(messages, cutoff).map((message) => message.key.id))
      .toEqual(['boundary', 'recent'])
  })

  it('downloads the cutoff boundary and completion chunks but skips older chunks', () => {
    const cutoff = 1_800_000_000_000
    const boundaries = new Set<number>()
    const recent = proto.Message.HistorySyncType.RECENT

    expect(shouldDownloadInitialHistoryChunk({ syncType: recent, oldestMsgInChunkTimestampSec: cutoff / 1000 }, cutoff, boundaries)).toBe(true)
    expect(shouldDownloadInitialHistoryChunk({ syncType: recent, oldestMsgInChunkTimestampSec: cutoff / 1000 - 1 }, cutoff, boundaries)).toBe(true)
    expect(shouldDownloadInitialHistoryChunk({ syncType: recent, oldestMsgInChunkTimestampSec: cutoff / 1000 - 10_000 }, cutoff, boundaries)).toBe(false)
    expect(shouldDownloadInitialHistoryChunk({ syncType: recent, oldestMsgInChunkTimestampSec: cutoff / 1000 - 20_000, progress: 100 }, cutoff, boundaries)).toBe(true)
    expect(shouldDownloadInitialHistoryChunk({ syncType: proto.Message.HistorySyncType.ON_DEMAND,
      oldestMsgInChunkTimestampSec: cutoff / 1000 - 30_000 }, cutoff, boundaries)).toBe(true)
  })

  it('suppresses protocol controls and status broadcasts while admitting channel posts', () => {
    const control: WAMessage = {
      key: { id: 'control', remoteJid: '15550002222@s.whatsapp.net', fromMe: true },
      messageTimestamp: 1_800_000_000,
      message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION } }
    }

    expect(normalizeWhatsAppMessage(control)).toEqual({})
    expect(normalizeWhatsAppMessage(textMessage('status', 'status@broadcast', 1_800_000_000_000))).toEqual({})
    expect(normalizeWhatsAppMessage(textMessage('channel', '12345@newsletter', 1_800_000_000_000)).message)
      .toMatchObject({ id: 'channel', chatId: '12345@newsletter', text: 'channel' })
    expect(isVisibleChatJid('15550003333@s.whatsapp.net')).toBe(true)
    expect(isVisibleChatJid('status@broadcast')).toBe(false)
    expect(isVisibleChatJid('12345@newsletter')).toBe(true)
  })
})
