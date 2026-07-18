// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MessageDto } from '../src/shared/contracts'
import { MessageBubble } from '../src/renderer/src/components/MessageBubble'

function createMessage(patch: Partial<MessageDto> = {}): MessageDto {
  return {
    id: 'message-1', chatId: 'chat@g.us', senderId: 'sender@lid', senderName: 'Akshitha', fromMe: false,
    kind: 'text', text: 'Strip light', timestamp: 1_720_000_000_000, status: 'delivered', edited: false, deleted: false,
    reactions: [], ...patch
  }
}

describe('MessageBubble', () => {
  it('shows a stable quote preview and reserves a reaction row', () => {
    const onOpenQuote = vi.fn()
    const { container } = render(<MessageBubble message={createMessage({
      quotedMessageId: 'quoted-1', quoted: { id: 'quoted-1', senderName: 'You', fromMe: true, kind: 'text', text: 'Original message' },
      reactions: [{ senderId: 'friend', emoji: '❤️' }]
    })} showSender onReply={vi.fn()} onForward={vi.fn()} onOpenQuote={onOpenQuote} onResize={vi.fn()} onError={vi.fn()} />)

    expect(screen.getByText('Akshitha')).toBeInTheDocument()
    expect(screen.getByText('Original message')).toBeInTheDocument()
    expect(container.querySelector('.message-row')).toHaveClass('has-reactions')
    fireEvent.click(screen.getByRole('button', { name: /You Original message/i }))
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

    expect(container.querySelector('.message-image')).toHaveStyle({ aspectRatio: '1200 / 800', width: '360px' })
  })

  it('shows an explicit retry action for failed outgoing messages', () => {
    const onRetry = vi.fn()
    render(<MessageBubble message={createMessage({ fromMe: true, status: 'failed', error: 'Network error' })}
      showSender={false} onReply={vi.fn()} onForward={vi.fn()} onOpenQuote={vi.fn()} onResize={vi.fn()}
      onRetry={onRetry} onError={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledWith('message-1')
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
})
