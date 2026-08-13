import { Check, CheckCheck, CircleAlert, Clock3 } from 'lucide-react'
import type { DeliveryState } from '../../../shared/contracts'

const DELIVERY_LABELS: Record<DeliveryState, string> = {
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed to send'
}

export function DeliveryReceipt({ status, className = '' }: { status: DeliveryState; className?: string }): React.JSX.Element {
  const stateClass = status === 'read' ? 'read' : status === 'failed' ? 'failed' : status
  const icon = status === 'queued' || status === 'sending' ? <Clock3 />
    : status === 'failed' ? <CircleAlert />
      : status === 'delivered' || status === 'read' ? <CheckCheck /> : <Check />
  return <span className={`delivery-receipt ${stateClass} ${className}`.trim()} role="img" aria-label={DELIVERY_LABELS[status]}>{icon}</span>
}
