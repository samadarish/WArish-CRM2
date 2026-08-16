import {
  BufferJSON,
  getContentType,
  normalizeMessageContent,
  proto,
  type WAMessage
} from '@whiskeysockets/baileys'
import type { AttachmentDto, DeliveryState, MessageKind, QuotedMessageDto, RichMessageDto } from '../shared/contracts'
import type { StoredMessage } from './database'

export interface NormalizedReaction {
  messageId: string
  senderId: string
  emoji?: string
}

export interface NormalizedEnvelope {
  message?: StoredMessage
  reaction?: NormalizedReaction
  deletionId?: string
  edit?: { messageId: string; text: string }
}

const CONTROL_MESSAGE_TYPES = new Set([
  'senderKeyDistributionMessage',
  'fastRatchetKeySenderKeyDistributionMessage',
  'messageContextInfo',
  'albumMessage'
])

export function isVisibleChatJid(jid: string | null | undefined): jid is string {
  return Boolean(jid) && jid !== 'status@broadcast' && !jid!.endsWith('@broadcast')
}

export function normalizeWhatsAppMessage(message: WAMessage): NormalizedEnvelope {
  const id = message.key.id
  const chatId = message.key.remoteJid
  if (!id || !isVisibleChatJid(chatId)) return {}

  const content = normalizeMessageContent(message.message)
  if (!content) return {}
  const type = getContentType(content)
  if (!type) return {}

  if (type === 'reactionMessage' && content.reactionMessage?.key?.id) {
    return {
      reaction: {
        messageId: content.reactionMessage.key.id,
        senderId: message.key.fromMe ? 'me' : message.key.participant ?? message.key.remoteJid ?? 'unknown',
        emoji: content.reactionMessage.text || undefined
      }
    }
  }

  if (type === 'protocolMessage') {
    const protocol = content.protocolMessage
    const targetId = protocol?.key?.id
    if (targetId && protocol?.type === proto.Message.ProtocolMessage.Type.REVOKE) return { deletionId: targetId }
    const editedText = protocol?.editedMessage?.conversation ?? protocol?.editedMessage?.extendedTextMessage?.text
    if (targetId && editedText) return { edit: { messageId: targetId, text: editedText } }
    return {}
  }

  if (CONTROL_MESSAGE_TYPES.has(type)) return {}

  const extracted = extractContent(type, content as Record<string, any>)
  const quoted = extractQuotedMessage(extracted.contextInfo)
  const timestampSeconds = Number(message.messageTimestamp ?? 0)
  const timestamp = Number.isFinite(timestampSeconds) && timestampSeconds > 0 ? timestampSeconds * 1000 : Date.now()
  return {
    message: {
      id,
      chatId,
      senderId: message.key.participant ?? (message.key.fromMe ? undefined : chatId),
      senderName: message.pushName ?? undefined,
      fromMe: Boolean(message.key.fromMe),
      kind: extracted.kind,
      text: extracted.text,
      timestamp,
      status: mapStatus(Number(message.status ?? 0)),
      quotedMessageId: quoted?.id ?? extracted.contextInfo?.stanzaId ?? undefined,
      quoted,
      rich: extracted.rich,
      edited: Boolean((message.message as any)?.editedMessage),
      rawPayload: Buffer.from(JSON.stringify(message, BufferJSON.replacer), 'utf8'),
      attachment: extracted.attachment
        ? {
            id: `attachment:${id}`,
            kind: extracted.attachmentKind!,
            fileName: extracted.attachment.fileName,
            mimeType: extracted.attachment.mimetype,
            size: numberValue(extracted.attachment.fileLength),
            width: numberValue(extracted.attachment.width),
            height: numberValue(extracted.attachment.height),
            durationSeconds: numberValue(extracted.attachment.seconds),
            thumbnailDataUrl: thumbnailDataUrl(extracted.attachment.jpegThumbnail),
            downloadState: 'remote'
          }
        : undefined
    }
  }
}

export function deserializeRawMessage(raw: Buffer): WAMessage {
  return JSON.parse(raw.toString('utf8'), BufferJSON.reviver) as WAMessage
}

interface ExtractedContent {
  kind: MessageKind
  text?: string
  contextInfo?: Record<string, any>
  attachment?: Record<string, any>
  attachmentKind?: AttachmentDto['kind']
  rich?: RichMessageDto
}

function extractContent(type: string, content: Record<string, any>): ExtractedContent {
  switch (type) {
    case 'conversation':
      return { kind: 'text', text: content.conversation }
    case 'extendedTextMessage':
      return { kind: 'text', text: content.extendedTextMessage?.text, contextInfo: content.extendedTextMessage?.contextInfo }
    case 'imageMessage':
      return { kind: 'image', text: content.imageMessage?.caption, contextInfo: content.imageMessage?.contextInfo,
        attachment: content.imageMessage, attachmentKind: 'image' }
    case 'videoMessage':
      return { kind: 'video', text: content.videoMessage?.caption, contextInfo: content.videoMessage?.contextInfo,
        attachment: content.videoMessage, attachmentKind: 'video' }
    case 'documentMessage':
      return { kind: 'document', text: content.documentMessage?.caption, contextInfo: content.documentMessage?.contextInfo,
        attachment: content.documentMessage, attachmentKind: 'document' }
    case 'audioMessage':
      return { kind: content.audioMessage?.ptt ? 'voice' : 'audio', contextInfo: content.audioMessage?.contextInfo,
        attachment: content.audioMessage, attachmentKind: content.audioMessage?.ptt ? 'voice' : 'audio' }
    case 'stickerMessage':
      return { kind: 'sticker', contextInfo: content.stickerMessage?.contextInfo,
        attachment: content.stickerMessage, attachmentKind: 'sticker' }
    case 'locationMessage':
    case 'liveLocationMessage':
      return { kind: 'location', text: 'Location' }
    case 'contactMessage':
    case 'contactsArrayMessage':
      return { kind: 'contact', text: 'Contact card' }
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return { kind: 'poll', text: firstText(
        content.pollCreationMessage?.name, content.pollCreationMessageV2?.name, content.pollCreationMessageV3?.name
      ) ?? 'Poll' }
    case 'templateMessage': {
      const value = content.templateMessage ?? {}
      const hydrated = value.hydratedTemplate ?? value.hydratedFourRowTemplate ?? {}
      const interactive = value.interactiveMessageTemplate ?? {}
      const rich: RichMessageDto = {
        type: 'template',
        title: firstText(hydrated.hydratedTitleText, interactive.header?.title, 'Message template'),
        body: firstText(hydrated.hydratedContentText, interactive.body?.text),
        footer: firstText(hydrated.hydratedFooterText, interactive.footer?.text)
      }
      return { kind: 'rich', text: rich.body ?? rich.title, contextInfo: value.contextInfo, rich }
    }
    case 'productMessage': {
      const value = content.productMessage ?? {}
      const product = value.product ?? {}
      const price = formatProductPrice(product.currencyCode, product.priceAmount1000)
      const rich: RichMessageDto = {
        type: 'product', title: firstText(product.title, value.catalog?.title, 'Product'),
        body: firstText(value.body, product.description, value.catalog?.description),
        footer: firstText(price, value.footer)
      }
      return { kind: 'rich', text: rich.title, contextInfo: value.contextInfo, rich }
    }
    case 'commentMessage': {
      const value = content.commentMessage ?? {}
      const nestedContent = normalizeMessageContent(value.message)
      const nestedType = nestedContent ? getContentType(nestedContent) : undefined
      const nested = nestedType ? extractContent(nestedType, nestedContent as Record<string, any>) : undefined
      const rich: RichMessageDto = { type: 'comment', title: 'Comment', body: nested?.text ?? nested?.rich?.body ?? 'Commented on a message' }
      return { kind: 'rich', text: rich.body, contextInfo: { stanzaId: value.targetMessageKey?.id }, rich }
    }
    case 'buttonsMessage': {
      const value = content.buttonsMessage ?? {}
      const rich: RichMessageDto = { type: 'interactive', title: firstText(value.text, 'Interactive message'),
        body: firstText(value.contentText), footer: firstText(value.footerText), itemCount: value.buttons?.length || undefined }
      return { kind: 'rich', text: rich.body ?? rich.title, contextInfo: value.contextInfo, rich }
    }
    case 'listMessage': {
      const value = content.listMessage ?? {}
      const itemCount = Array.isArray(value.sections)
        ? value.sections.reduce((count: number, section: any) => count + Number(section.rows?.length ?? 0), 0) : 0
      const rich: RichMessageDto = { type: 'interactive', title: firstText(value.title, 'List message'),
        body: firstText(value.description, value.buttonText), footer: firstText(value.footerText), itemCount: itemCount || undefined }
      return { kind: 'rich', text: rich.body ?? rich.title, contextInfo: value.contextInfo, rich }
    }
    case 'interactiveMessage': {
      const value = content.interactiveMessage ?? {}
      const itemCount = value.carouselMessage?.cards?.length ?? value.nativeFlowMessage?.buttons?.length
      const rich: RichMessageDto = { type: 'interactive', title: firstText(value.header?.title, 'Interactive message'),
        body: firstText(value.body?.text, value.header?.subtitle), footer: firstText(value.footer?.text), itemCount: itemCount || undefined }
      return { kind: 'rich', text: rich.body ?? rich.title, contextInfo: value.contextInfo, rich }
    }
    case 'pollUpdateMessage': {
      const value = content.pollUpdateMessage ?? {}
      const rich: RichMessageDto = { type: 'poll-update', title: 'Poll response', body: 'A vote was submitted' }
      return { kind: 'rich', text: rich.title, contextInfo: { stanzaId: value.pollCreationMessageKey?.id }, rich }
    }
    default:
      return { kind: 'unsupported', text: 'This message type is not supported yet' }
  }
}

function extractQuotedMessage(contextInfo?: Record<string, any>): QuotedMessageDto | undefined {
  const id = contextInfo?.stanzaId
  if (typeof id !== 'string' || !id) return undefined
  const content = normalizeMessageContent(contextInfo.quotedMessage)
  const type = content ? getContentType(content) : undefined
  const extracted = type ? extractContent(type, content as Record<string, any>) : undefined
  return {
    id,
    kind: extracted?.kind ?? 'unsupported',
    text: extracted?.text ?? extracted?.rich?.body ?? extracted?.rich?.title ?? 'Referenced message'
  }
}

function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim()
}

function formatProductPrice(currency: unknown, amount1000: unknown): string | undefined {
  if (typeof currency !== 'string' || amount1000 === null || amount1000 === undefined) return undefined
  const amount = Number(amount1000) / 1_000
  if (!Number.isFinite(amount)) return undefined
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount) }
  catch { return `${currency} ${amount.toFixed(2)}` }
}

function mapStatus(status: number): DeliveryState {
  if (status >= 4) return 'read'
  if (status === 3) return 'delivered'
  if (status >= 1) return 'sent'
  return 'sent'
}

function numberValue(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function thumbnailDataUrl(value: unknown): string | undefined {
  if (!(value instanceof Uint8Array) && !Buffer.isBuffer(value)) return undefined
  return `data:image/jpeg;base64,${Buffer.from(value).toString('base64')}`
}
