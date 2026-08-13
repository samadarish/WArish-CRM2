// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { DeliveryState } from '../src/shared/contracts'
import { DeliveryReceipt } from '../src/renderer/src/components/DeliveryReceipt'

describe('DeliveryReceipt', () => {
  it.each([
    ['queued', 'Queued', 'clock-3'],
    ['sending', 'Sending', 'clock-3'],
    ['sent', 'Sent', 'check'],
    ['delivered', 'Delivered', 'check-check'],
    ['read', 'Read', 'check-check'],
    ['failed', 'Failed to send', 'circle-alert']
  ] satisfies Array<[DeliveryState, string, string]>)('renders an accessible %s state', (status, label, icon) => {
    const { container } = render(<DeliveryReceipt status={status} />)

    expect(screen.getByRole('img', { name: label })).toHaveClass('delivery-receipt', status)
    expect(container.querySelector(`.lucide-${icon}`)).toBeInTheDocument()
  })
})
