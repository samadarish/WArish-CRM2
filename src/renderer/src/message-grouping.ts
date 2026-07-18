import type { MessageDto } from '../../shared/contracts'

export type MessageGroupPosition = 'single' | 'first' | 'middle' | 'last'

const GROUP_WINDOW_MS = 5 * 60_000

export function messageGroupPositions(messages: MessageDto[]): Map<string, MessageGroupPosition> {
  const result = new Map<string, MessageGroupPosition>()
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    const joinsPrevious = canGroupMessages(messages[index - 1], message)
    const joinsNext = canGroupMessages(message, messages[index + 1])
    result.set(message.id, joinsPrevious ? (joinsNext ? 'middle' : 'last') : (joinsNext ? 'first' : 'single'))
  }
  return result
}

export function canGroupMessages(previous?: MessageDto, next?: MessageDto): boolean {
  if (!previous || !next || previous.fromMe !== next.fromMe) return false
  if (!previous.fromMe && (previous.senderId ?? previous.senderName) !== (next.senderId ?? next.senderName)) return false
  if (previous.reactions.length || next.reactions.length) return false
  if (!sameLocalDay(previous.timestamp, next.timestamp)) return false
  const elapsed = next.timestamp - previous.timestamp
  return elapsed >= 0 && elapsed <= GROUP_WINDOW_MS
}

function sameLocalDay(left: number, right: number): boolean {
  const first = new Date(left)
  const second = new Date(right)
  return first.getFullYear() === second.getFullYear() && first.getMonth() === second.getMonth() && first.getDate() === second.getDate()
}
