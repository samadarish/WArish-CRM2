// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MessageDto } from '../src/shared/contracts'
import { MessageBubble } from '../src/renderer/src/components/MessageBubble'

function createMessage(patch: Partial<MessageDto> = {}): MessageDto {
  return {
    id: 'message-1', chatId: 'chat@g.us', senderId: 'sender@lid', senderName: 'Akshitha', fromMe: false,
    kind: 'text', text: 'Strip light', timestamp: 1_720_000_000_000, status: 'delivered', edited: false, deleted: false,
    reactions: [], ...patch
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'warish')
})

describe('MessageBubble', () => {
  it('turns web addresses into safe external links without swallowing punctuation', () => {
    render(<MessageBubble message={createMessage({ text: 'Open https://example.com/orders/42, or www.example.org/help.' })}
      showSender={false} onReply={vi.fn()} onForward={vi.fn()} onOpenQuote={vi.fn()} onResize={vi.fn()} onError={vi.fn()} />)

    expect(screen.getByRole('link', { name: 'https://example.com/orders/42' })).toHaveAttribute('href', 'https://example.com/orders/42')
    expect(screen.getByRole('link', { name: 'www.example.org/help' })).toHaveAttribute('href', 'https://www.example.org/help')
    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    }
    expect(screen.getByText(/, or/)).toBeInTheDocument()
    expect(screen.getByText('www.example.org/help').parentElement).toHaveTextContent(/help\.$/)
  })

  it('shows a stable quote preview and reserves a reaction row', () => {
    const onOpenQuote = vi.fn()
    const { container } = render(<MessageBubble message={createMessage({
      quotedMessageId: 'quoted-1', quoted: { id: 'quoted-1', senderName: 'You', fromMe: true, kind: 'text', text: 'Original message' },
      reactions: [{ senderId: 'friend', emoji: '❤️' }]
    })} showSender onReply={vi.fn()} onForward={vi.fn()} onOpenQuote={onOpenQuote} onResize={vi.fn()} onError={vi.fn()} />)

    expect(screen.getByText('Akshitha')).toBeInTheDocument()
    expect(screen.getByText('Original message')).toBeInTheDocument()
    expect(container.querySelector('.message-row')).toHaveClass('has-reactions')
    fireEvent.click(screen.getByRole('button', { name: 'You: Original message' }))
    expect(onOpenQuote).toHaveBeenCalledWith('quoted-1')
  })

  it('renders readable rich-message fields without protobuf names or duplicated preview text', () => {
    render(<MessageBubble message={createMessage({ kind: 'rich', text: 'Desk lamp',
      rich: { type: 'product', title: 'Desk lamp', body: 'Warm white', footer: '$12.99' }
    })} showSender={false} onReply={vi.fn()} onForward={vi.fn()} onOpenQuote={vi.fn()} onResize={vi.fn()} onError={vi.fn()} />)

    expect(screen.getAllByText('Desk lamp')).toHaveLength(1)
    expect(screen.getByText('Warm white')).toBeInTheDocument()
    expect(screen.getByText('$12.99')).toBeInTheDocument()
    expect(screen.queryByText(/productMessage/)).not.toBeInTheDocument()
  })

  it('requests a targeted row measurement when cached media finishes sizing', () => {
    const onResize = vi.fn()
    render(<MessageBubble message={createMessage({ kind: 'image', text: undefined,
      attachment: { id: 'attachment-1', messageId: 'message-1', kind: 'image', cacheToken: 'cached-image.jpg', downloadState: 'ready' }
    })} showSender={false} onReply={vi.fn()} onForward={vi.fn()} onOpenQuote={vi.fn()} onResize={onResize} onError={vi.fn()} />)

    fireEvent.load(screen.getByRole('img', { name: 'image' }))
    expect(onResize).toHaveBeenCalledOnce()
  })

  it('reserves the known media aspect ratio before an image finishes loading', () => {
    const { container } = render(<MessageBubble message={createMessage({ kind: 'image', text: undefined,
      attachment: { id: 'attachment-sized', messageId: 'message-1', kind: 'image', cacheToken: 'sized-image.jpg',
        width: 1200, height: 800, downloadState: 'ready' }
    })} showSender={false} onReply={vi.fn()} onForward={vi.fn()} onOpenQuote={vi.fn()} onResize={vi.fn()} onError={vi.fn()} />)

    expect(container.querySelector('.media-frame')).toHaveStyle({ aspectRatio: '1200 / 800', width: '360px' })
  })

  it('overlays metadata inside a captionless image for both sent and received messages', () => {
    const attachment = { id: 'attachment-overlay', messageId: 'message-1', kind: 'image' as const,
      width: 1200, height: 800, downloadState: 'remote' as const }
    const props = { showSender: false, onReply: vi.fn(), onForward: vi.fn(), onOpenQuote: vi.fn(),
      onResize: vi.fn(), onError: vi.fn() }
    const { container, rerender } = render(<MessageBubble message={createMessage({
      kind: 'image', text: undefined, fromMe: true, status: 'read', attachment
    })} {...props} />)

    let bubble = container.querySelector('.message-bubble')
    let frame = container.querySelector('.media-frame')
    let metadata = container.querySelector('.message-meta')
    expect(bubble).toHaveClass('image-meta-overlay', 'bare-image')
    expect(metadata).toHaveClass('image-message-meta')
    expect(metadata?.parentElement).toBe(frame)
    expect(screen.getByRole('img', { name: 'Read' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download Photo' })).toBeInTheDocument()

    rerender(<MessageBubble message={createMessage({ kind: 'image', text: undefined, fromMe: false, attachment })} {...props} />)
    bubble = container.querySelector('.message-bubble')
    frame = container.querySelector('.media-frame')
    metadata = container.querySelector('.message-meta')
    expect(bubble).toHaveClass('image-meta-overlay', 'bare-image')
    expect(metadata?.parentElement).toBe(frame)
    expect(container.querySelector('.delivery-receipt')).not.toBeInTheDocument()
  })

  it('keeps captioned images and other media metadata in normal bubble flow', () => {
    const props = { showSender: false, onReply: vi.fn(), onForward: vi.fn(), onOpenQuote: vi.fn(),
      onResize: vi.fn(), onError: vi.fn() }
    const imageAttachment = { id: 'attachment-caption', messageId: 'message-1', kind: 'image' as const,
      width: 800, height: 600, downloadState: 'remote' as const }
    const { container, rerender } = render(<MessageBubble message={createMessage({
      kind: 'image', text: 'Image caption', attachment: imageAttachment
    })} {...props} />)

    let bubble = container.querySelector('.message-bubble')
    let metadata = container.querySelector('.message-meta')
    expect(screen.getByText('Image caption')).toBeInTheDocument()
    expect(bubble).not.toHaveClass('image-meta-overlay', 'bare-image')
    expect(metadata?.parentElement).toBe(bubble)

    rerender(<MessageBubble message={createMessage({ kind: 'video', text: undefined, attachment: {
      ...imageAttachment, id: 'attachment-video', kind: 'video'
    } })} {...props} />)
    bubble = container.querySelector('.message-bubble')
    metadata = container.querySelector('.message-meta')
    expect(bubble).not.toHaveClass('image-meta-overlay', 'bare-image')
    expect(metadata?.parentElement).toBe(bubble)

    rerender(<MessageBubble message={createMessage({ kind: 'image', text: undefined, attachment: undefined })} {...props} />)
    bubble = container.querySelector('.message-bubble')
    metadata = container.querySelector('.message-meta')
    expect(bubble).not.toHaveClass('image-meta-overlay', 'bare-image')
    expect(metadata?.parentElement).toBe(bubble)
  })

  it('keeps the same media frame before and after download', () => {
    const remoteAttachment = { id: 'attachment-stable', messageId: 'message-1', kind: 'image' as const,
      width: 800, height: 1200, downloadState: 'remote' as const }
    const props = { showSender: false, onReply: vi.fn(), onForward: vi.fn(), onOpenQuote: vi.fn(), onResize: vi.fn(), onError: vi.fn() }
    const { container, rerender } = render(<MessageBubble message={createMessage({ kind: 'image', text: undefined,
      attachment: remoteAttachment })} {...props} />)
    const remoteStyle = container.querySelector('.media-frame')?.getAttribute('style')

    rerender(<MessageBubble message={createMessage({ kind: 'image', text: undefined, attachment: {
      ...remoteAttachment, cacheToken: 'downloaded.jpg', downloadState: 'ready'
    } })} {...props} />)
    expect(container.querySelector('.media-frame')?.getAttribute('style')).toBe(remoteStyle)
    expect(container.querySelector('.media-frame')).toHaveStyle({ aspectRatio: '800 / 1200', width: '253px' })
  })

  it('uses a blurred preview behind remote media controls', () => {
    const { container } = render(<MessageBubble message={createMessage({ kind: 'video', text: undefined,
      attachment: { id: 'attachment-preview', messageId: 'message-1', kind: 'video', width: 1280, height: 720,
        thumbnailDataUrl: 'data:image/jpeg;base64,/9j/2Q==', downloadState: 'remote' }
    })} showSender={false} onReply={vi.fn()} onForward={vi.fn()} onOpenQuote={vi.fn()} onResize={vi.fn()} onError={vi.fn()} />)

    expect(container.querySelector('.media-thumbnail')).toHaveAttribute('src', 'data:image/jpeg;base64,/9j/2Q==')
    expect(screen.getByRole('button', { name: 'Download Video' })).toBeInTheDocument()
  })

  it('requests a small thumbnail only after remote media becomes visible', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined
    class TestIntersectionObserver {
      readonly root = null
      readonly rootMargin = ''
      readonly thresholds = [0.01]
      constructor(callback: IntersectionObserverCallback) { intersectionCallback = callback }
      observe(): void { /* Controlled by the test. */ }
      disconnect(): void { /* Controlled by the component. */ }
      unobserve(): void { /* Not used. */ }
      takeRecords(): IntersectionObserverEntry[] { return [] }
    }
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
    const thumbnail = vi.fn().mockResolvedValue({ thumbnailDataUrl: 'data:image/jpeg;base64,/9j/2Q==' })
    Object.defineProperty(window, 'warish', { configurable: true, value: { media: { thumbnail } } })
    const { container } = render(<MessageBubble message={createMessage({ kind: 'image', text: undefined,
      attachment: { id: 'attachment-visible', messageId: 'message-1', kind: 'image', width: 640, height: 480, downloadState: 'remote' }
    })} showSender={false} onReply={vi.fn()} onForward={vi.fn()} onOpenQuote={vi.fn()} onResize={vi.fn()} onError={vi.fn()} />)

    expect(thumbnail).not.toHaveBeenCalled()
    act(() => intersectionCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    await waitFor(() => expect(container.querySelector('.media-thumbnail')).toBeInTheDocument())
    expect(thumbnail).toHaveBeenCalledOnce()
    expect(thumbnail).toHaveBeenCalledWith('message-1')
  })

  it('applies grouped bubble classes and keeps quoted replies to one compact preview line', () => {
    const { container } = render(<MessageBubble groupPosition="middle" message={createMessage({
      quotedMessageId: 'quoted-media', quoted: { id: 'quoted-media', senderName: 'Akshitha', kind: 'image' }
    })} showSender={false} onReply={vi.fn()} onForward={vi.fn()} onOpenQuote={vi.fn()} onResize={vi.fn()} onError={vi.fn()} />)

    expect(container.querySelector('.message-row')).toHaveClass('group-middle')
    expect(container.querySelector('.quoted-message span')).toHaveTextContent('Photo')
  })

  it('shows an explicit retry action for failed outgoing messages', () => {
    const onRetry = vi.fn()
    const { container } = render(<MessageBubble message={createMessage({ fromMe: true, status: 'failed', error: 'Network error',
      kind: 'image', text: undefined, attachment: {
        id: 'attachment-failed', messageId: 'message-1', kind: 'image', width: 640, height: 480, downloadState: 'remote'
      }
    })}
      showSender={false} onReply={vi.fn()} onForward={vi.fn()} onOpenQuote={vi.fn()} onResize={vi.fn()}
      onRetry={onRetry} onError={vi.fn()} />)

    expect(container.querySelector('.message-meta')?.parentElement).toBe(container.querySelector('.media-frame'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledWith('message-1')
  })

  it('shows a read receipt only for an outgoing message', () => {
    const props = { showSender: false, onReply: vi.fn(), onForward: vi.fn(), onOpenQuote: vi.fn(),
      onResize: vi.fn(), onError: vi.fn() }
    const { container, rerender } = render(<MessageBubble message={createMessage({ fromMe: true, status: 'read' })} {...props} />)

    expect(screen.getByRole('img', { name: 'Read' })).toHaveClass('delivery-receipt', 'read')
    rerender(<MessageBubble message={createMessage({ fromMe: false, status: 'read' })} {...props} />)
    expect(container.querySelector('.delivery-receipt')).not.toBeInTheDocument()
  })

  it('keeps channel posts read-only while retaining copy and forward actions', () => {
    const { container } = render(<MessageBubble message={createMessage()} readOnly showSender={false} onReply={vi.fn()} onForward={vi.fn()}
      onOpenQuote={vi.fn()} onResize={vi.fn()} onError={vi.fn()} />)

    expect(container.querySelector('[aria-label="Reply"]')).not.toBeInTheDocument()
    expect(container.querySelector('[aria-label="React with heart"]')).not.toBeInTheDocument()
    expect(container.querySelector('[aria-label="Delete message"]')).not.toBeInTheDocument()
    expect(container.querySelector('[aria-label="Copy message text"]')).toBeInTheDocument()
    expect(container.querySelector('[aria-label="Forward"]')).toBeInTheDocument()
  })

  it('offers direct CRM note and task actions with the selected message', () => {
    const message = createMessage({ chatId: 'person@s.whatsapp.net' })
    const onAddNote = vi.fn()
    const onAddTask = vi.fn()
    const { container } = render(<MessageBubble message={message} showSender={false} onReply={vi.fn()} onForward={vi.fn()}
      onAddNote={onAddNote} onAddTask={onAddTask} onOpenQuote={vi.fn()} onResize={vi.fn()} onError={vi.fn()} />)
    const bubble = within(container)

    fireEvent.click(bubble.getByRole('button', { name: 'More message actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to CRM notes' }))
    fireEvent.click(bubble.getByRole('button', { name: 'More message actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create follow-up' }))
    expect(onAddNote).toHaveBeenCalledWith(message)
    expect(onAddTask).toHaveBeenCalledWith(message)
  })
})
