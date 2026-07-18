import { describe, expect, it } from 'vitest'
import type { MessageDto } from '../src/shared/contracts'
import { messageGroupPositions } from '../src/renderer/src/message-grouping'

function message(id: string, timestamp: number, patch: Partial<MessageDto> = {}): MessageDto {
  return {
    id, chatId: 'chat@g.us', senderId: 'sender-a@lid', senderName: 'Sender A', fromMe: false,
    kind: 'text', text: id, timestamp, status: 'read', edited: false, deleted: false, reactions: [], ...patch
  }
}

describe('message grouping', () => {
  it('marks uninterrupted same-sender messages as first, middle, and last', () => {
    const positions = messageGroupPositions([
      message('one', 1_720_000_000_000),
      message('two', 1_720_000_060_000),
      message('three', 1_720_000_120_000)
    ])
    expect([...positions.values()]).toEqual(['first', 'middle', 'last'])
  })

  it('breaks groups on sender, direction, reaction, and five-minute boundaries', () => {
    const start = 1_720_000_000_000
    const positions = messageGroupPositions([
      message('sender-a', start),
      message('sender-b', start + 10_000, { senderId: 'sender-b@lid' }),
      message('mine', start + 20_000, { fromMe: true, senderId: undefined }),
      message('reaction', start + 30_000, { fromMe: true, senderId: undefined, reactions: [{ senderId: 'friend', emoji: '👍' }] }),
      message('late', start + 6 * 60_000, { fromMe: true, senderId: undefined })
    ])
    expect([...positions.values()]).toEqual(['single', 'single', 'single', 'single', 'single'])
  })

  it('breaks a sequence at the local day boundary', () => {
    const first = new Date(2026, 6, 18, 23, 59, 30).getTime()
    const second = new Date(2026, 6, 19, 0, 0, 10).getTime()
    expect([...messageGroupPositions([message('before', first), message('after', second)]).values()]).toEqual(['single', 'single'])
  })
})
