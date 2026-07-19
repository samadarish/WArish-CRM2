import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { format } from 'date-fns'
import { Check, CheckCheck, Clock3, Copy, Download, File, Forward, Heart, Images, List, ListTodo, MessageSquareText, NotebookPen, Package, Pencil, RefreshCw, Reply, Trash2, Vote, X } from 'lucide-react'
import type { MessageDto } from '../../../shared/contracts'
import type { MessageGroupPosition } from '../message-grouping'
import { useMotionPhase } from '../motion-context'
import { MotionPresence } from '../motion'

export const MessageBubble = memo(function MessageBubble({ message, groupPosition = 'single', readOnly = false, showSender, onReply, onForward, onAddNote, onAddTask, onOpenQuote, onResize, onRetry, onError }: {
  message: MessageDto
  groupPosition?: MessageGroupPosition
  readOnly?: boolean
  showSender: boolean
  onReply(message: MessageDto): void
  onForward(message: MessageDto): void
  onAddNote?(message: MessageDto): void
  onAddTask?(message: MessageDto): void
  onOpenQuote(messageId: string): void
  onResize(): void
  onRetry?(messageId: string): void
  onError(error: unknown): void
}): React.JSX.Element {
  const [media, setMedia] = useState(() => message.attachment?.cacheToken
    ? { url: `warish-media://cache/${encodeURIComponent(message.attachment.cacheToken)}`, token: message.attachment.cacheToken }
    : undefined)
  const [downloading, setDownloading] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [editText, setEditText] = useState(message.text ?? '')
  const [deleteOpen, setDeleteOpen] = useState(false)
  useEffect(() => {
    const token = message.attachment?.cacheToken
    const draftToken = message.attachment?.draftToken
    setMedia(token
      ? { url: `warish-media://cache/${encodeURIComponent(token)}`, token }
      : draftToken ? { url: `warish-media://drafts/${encodeURIComponent(draftToken)}`, token: draftToken } : undefined)
  }, [message.attachment?.cacheToken, message.attachment?.draftToken])
  const download = async (): Promise<void> => {
    setDownloading(true)
    try {
      const downloaded = await window.warish.media.download(message.id)
      setMedia({ url: downloaded.url, token: downloaded.cacheToken })
      onResize()
    } catch (error) { onError(error) } finally { setDownloading(false) }
  }
  const cancelDownload = async (): Promise<void> => {
    try { await window.warish.media.cancel(message.id) } catch (error) { onError(error) }
  }
  const edit = async (): Promise<void> => {
    if (!editText.trim()) return
    try { await window.warish.messages.edit(message.chatId, message.id, editText.trim()); setEditOpen(false) }
    catch (error) { onError(error) }
  }
  const remove = async (mode: 'for-me' | 'for-everyone'): Promise<void> => {
    try { await window.warish.messages.delete(message.chatId, message.id, mode); setDeleteOpen(false) }
    catch (error) { onError(error) }
  }
  const react = async (): Promise<void> => {
    const hasOwnHeart = message.reactions.some((reaction) => reaction.senderId === 'me' && reaction.emoji === '❤️')
    try { await window.warish.messages.react(message.chatId, message.id, hasOwnHeart ? undefined : '❤️') } catch (error) { onError(error) }
  }
  const copy = async (): Promise<void> => {
    if (!message.text) return
    try { await navigator.clipboard.writeText(message.text) } catch (error) { onError(error) }
  }

  return (
    <article className={`message-row group-${groupPosition} ${message.fromMe ? 'mine' : ''} ${message.reactions.length ? 'has-reactions' : ''}`}>
      <div className={`message-bubble kind-${message.kind}`} tabIndex={0} aria-label={`${message.fromMe ? 'Sent' : 'Received'} ${message.kind} message`}>
        {showSender && message.senderName && <div className="sender-name">{message.senderName}</div>}
        {message.quotedMessageId && <button className="quoted-message" onClick={() => onOpenQuote(message.quotedMessageId!)}>
          <strong>{message.quoted?.fromMe ? 'You' : message.quoted?.senderName ?? 'Reply'}</strong>
          <span title={message.quoted?.text ?? messageKindLabel(message.quoted?.kind)}>{message.quoted?.text ?? messageKindLabel(message.quoted?.kind)}</span>
        </button>}
        {message.deleted ? <em className="deleted-message">This message was deleted</em> : <>
          {message.rich && <RichMessageCard message={message} />}
          <Media message={message} url={media?.url} cacheToken={media?.token} downloading={downloading}
            onDownload={() => void download()} onCancel={() => void cancelDownload()} onResize={onResize} onError={onError}
            onBroken={() => { setMedia(undefined); onError(new Error('The cached media file is unavailable. Download it again.')) }} />
          {message.text && !message.rich && <p className="message-text">{message.text}</p>}
        </>}
        <div className="message-meta">{message.edited && <span>edited</span>}<time>{format(message.timestamp, 'HH:mm')}</time>{message.fromMe && <DeliveryIcon status={message.status} />}</div>
        {!readOnly && message.status === 'failed' && onRetry && <button className="message-failed" onClick={() => onRetry(message.id)}><RefreshCw />Retry</button>}
        {message.reactions.length > 0 && <div className="reaction-pill">{message.reactions.map((reaction) => reaction.emoji).join(' ')}</div>}
        <div className="message-actions">
          {!readOnly && <button title="Reply" aria-label="Reply" onClick={() => onReply(message)}><Reply /></button>}
          {!readOnly && <button title="React with heart" aria-label="React with heart" onClick={() => void react()}><Heart /></button>}
          {message.text && <button title="Copy text" aria-label="Copy message text" onClick={() => void copy()}><Copy /></button>}
          {onAddNote && <button title="Add to CRM notes" aria-label="Add message to CRM notes" onClick={() => onAddNote(message)}><NotebookPen /></button>}
          {onAddTask && <button title="Create CRM task" aria-label="Create task from message" onClick={() => onAddTask(message)}><ListTodo /></button>}
          <button title="Forward" aria-label="Forward" onClick={() => onForward(message)}><Forward /></button>
          {!readOnly && message.fromMe && message.kind === 'text' && <button title="Edit" aria-label="Edit message" onClick={() => { setEditText(message.text ?? ''); setEditOpen(true) }}><Pencil /></button>}
          {!readOnly && <button title="Delete" aria-label="Delete message" onClick={() => setDeleteOpen(true)}><Trash2 /></button>}
        </div>
      </div>
      <MotionPresence show={editOpen}>{editOpen && <ActionDialog title="Edit message" onClose={() => setEditOpen(false)}>
        <textarea autoFocus value={editText} onChange={(event) => setEditText(event.target.value)} aria-label="Edited message" />
        <footer><button onClick={() => setEditOpen(false)}>Cancel</button><button className="primary-button" disabled={!editText.trim()} onClick={() => void edit()}>Save</button></footer>
      </ActionDialog>}</MotionPresence>
      <MotionPresence show={deleteOpen}>{deleteOpen && <ActionDialog title="Delete message" onClose={() => setDeleteOpen(false)}>
        <p>Choose how this message should be deleted.</p>
        <footer><button onClick={() => setDeleteOpen(false)}>Cancel</button><button className="secondary-button" onClick={() => void remove('for-me')}>Delete for me</button>
          {message.fromMe && <button className="danger-button" onClick={() => void remove('for-everyone')}>Delete for everyone</button>}</footer>
      </ActionDialog>}</MotionPresence>
    </article>
  )
})

function RichMessageCard({ message }: { message: MessageDto }): React.JSX.Element {
  const rich = message.rich!
  const Icon = rich.type === 'product' ? Package : rich.type === 'album' ? Images : rich.type === 'poll-update'
    ? Vote : rich.type === 'interactive' ? List : MessageSquareText
  return <section className={`rich-message-card rich-${rich.type}`}><div className="rich-message-heading"><Icon /><strong>{rich.title ?? messageKindLabel(message.kind)}</strong></div>
    {rich.body && rich.body !== rich.title && <p>{rich.body}</p>}
    {(rich.footer || rich.itemCount) && <footer>{rich.footer}{rich.footer && rich.itemCount ? ' · ' : ''}{rich.itemCount ? `${rich.itemCount} items` : ''}</footer>}
  </section>
}

function Media({ message, url, cacheToken, downloading, onDownload, onCancel, onResize, onError, onBroken }: {
  message: MessageDto; url?: string; cacheToken?: string; downloading: boolean; onDownload(): void; onCancel(): void; onResize(): void; onError(error: unknown): void; onBroken(): void
}): React.JSX.Element | null {
  const attachment = message.attachment
  const [thumbnail, setThumbnail] = useState(attachment?.thumbnailDataUrl)
  const frameRef = useRef<HTMLDivElement>(null)
  useEffect(() => setThumbnail(attachment?.thumbnailDataUrl), [attachment?.messageId, attachment?.thumbnailDataUrl])
  useEffect(() => {
    if (url || thumbnail || (message.kind !== 'image' && message.kind !== 'video')) return
    const frame = frameRef.current
    if (!frame || typeof IntersectionObserver === 'undefined') return
    let disposed = false
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      void window.warish.media.thumbnail(message.id).then((result) => {
        if (!disposed && result.thumbnailDataUrl) {
          setThumbnail(result.thumbnailDataUrl)
          onResize()
        }
      }).catch(() => { /* A missing preview must not interrupt the conversation. */ })
    }, { rootMargin: '120px 0px', threshold: 0.01 })
    observer.observe(frame)
    return () => { disposed = true; observer.disconnect() }
  }, [message.id, message.kind, onResize, thumbnail, url])
  if (!attachment) return null
  if (url && (message.kind === 'audio' || message.kind === 'voice')) return <audio className="message-audio" src={url} controls preload="metadata" onLoadedMetadata={onResize} onError={onBroken} />
  if (url && cacheToken && message.kind === 'document') return attachment.draftToken
    ? <div className="document-card"><File /><span>{attachment.fileName ?? 'Document'}</span></div>
    : <button className="document-card" onClick={() => void window.warish.media.open(cacheToken).catch(onError)}><File /><span>{attachment.fileName ?? 'Document'}</span></button>
  if (message.kind === 'image' || message.kind === 'video' || message.kind === 'sticker') {
    const label = attachment.fileName ?? messageKindLabel(message.kind)
    return <div ref={frameRef} className={`media-frame ${message.kind}`} style={mediaFrameStyle(attachment, message.kind)}>
      {thumbnail && <img className="media-thumbnail" src={thumbnail} alt="" aria-hidden="true" />}
      {url && (message.kind === 'image' || message.kind === 'sticker')
        ? <img className={`message-image ${message.kind}`} src={url} alt={message.text ?? message.kind} loading="lazy" decoding="async" onLoad={onResize} onError={onBroken} />
        : url && message.kind === 'video'
          ? <video className="message-video" src={url} controls preload="metadata" onLoadedMetadata={onResize} onError={onBroken} />
          : <button className="media-download" aria-label={downloading ? `Cancel ${label} download` : `Download ${label}`} onClick={downloading ? onCancel : onDownload}>
            <span className="download-circle">{downloading ? <X /> : <Download />}</span>
          </button>}
    </div>
  }
  return <button className="document-card" onClick={downloading ? onCancel : onDownload}>
    <File /><span>{downloading ? 'Cancel download' : attachment.fileName ?? messageKindLabel(message.kind)}</span>
  </button>
}

function mediaFrameStyle(attachment: NonNullable<MessageDto['attachment']>, kind: MessageDto['kind']): CSSProperties {
  const maxWidth = kind === 'sticker' ? 180 : 360
  const maxHeight = kind === 'sticker' ? 180 : 380
  const width = attachment.width
  const height = attachment.height
  if (!width || !height || width <= 0 || height <= 0) {
    return { width: kind === 'sticker' ? 180 : 260, aspectRatio: kind === 'sticker' ? '1 / 1' : '13 / 8' }
  }
  const scale = Math.min(1, maxWidth / width, maxHeight / height)
  return { width: Math.max(1, Math.round(width * scale)), aspectRatio: `${width} / ${height}` }
}

function messageKindLabel(kind?: MessageDto['kind']): string {
  const labels: Partial<Record<MessageDto['kind'], string>> = {
    image: 'Photo', video: 'Video', document: 'Document', audio: 'Audio', voice: 'Voice message', sticker: 'Sticker',
    location: 'Location', contact: 'Contact card', poll: 'Poll', rich: 'Rich message', unsupported: 'Referenced message'
  }
  return kind ? labels[kind] ?? 'Message' : 'Referenced message'
}

function DeliveryIcon({ status }: { status: MessageDto['status'] }): React.JSX.Element {
  if (status === 'queued' || status === 'sending') return <Clock3 />
  if (status === 'failed') return <RefreshCw className="delivery-failed" />
  return status === 'read' || status === 'delivered' ? <CheckCheck className={status === 'read' ? 'read' : ''} /> : <Check />
}

function ActionDialog({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }): React.JSX.Element {
  const motionPhase = useMotionPhase()
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [onClose])
  return createPortal(<div className="modal-backdrop" data-motion-state={motionPhase} role="presentation"
    aria-hidden={motionPhase === 'exiting' ? true : undefined} inert={motionPhase === 'exiting' ? true : undefined}
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="modal action-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button className="icon-button" aria-label={`Close ${title}`} onClick={onClose}><X /></button></header>
      <div className="action-dialog-content">{children}</div>
    </section>
  </div>, document.body)
}
