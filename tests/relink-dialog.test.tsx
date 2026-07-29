// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionState } from '../src/shared/contracts'
import { RelinkDialog } from '../src/renderer/src/components/ChatShell'
import { useUiStore } from '../src/renderer/src/store'

afterEach(() => {
  cleanup()
  useUiStore.setState({ notices: [] })
  Reflect.deleteProperty(window, 'warish')
})

describe('RelinkDialog', () => {
  it('keeps retry actions available while showing a connection failure', () => {
    installSessionApi()
    renderDialog({
      phase: 'offline',
      accountState: 'relink-required',
      message: 'WhatsApp compatibility changed. Refreshing and trying again...'
    })

    expect(screen.getByRole('alert')).toHaveTextContent('WhatsApp compatibility changed')
    expect(screen.getByRole('button', { name: 'Continue with QR code' })).toBeEnabled()
    expect(screen.getByRole('textbox', { name: 'International phone number' })).toBeEnabled()
  })

  it('shows a pairing request error inside the dialog', async () => {
    installSessionApi(vi.fn().mockRejectedValue(new Error('Could not prepare a QR code')))
    const dialog = renderDialog({ phase: 'logged-out', accountState: 'relink-required' })

    fireEvent.click(screen.getByRole('button', { name: 'Continue with QR code' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not prepare a QR code'))
    dialog.updateSession({ phase: 'pairing', accountState: 'relink-required' })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not prepare a QR code')
    expect(screen.getByRole('button', { name: 'Continue with QR code' })).toBeEnabled()
  })
})

function renderDialog(session: SessionState): { updateSession(next: SessionState): void } {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const onClose = vi.fn()
  const view = render(<QueryClientProvider client={queryClient}><RelinkDialog session={session} onClose={onClose} /></QueryClientProvider>)
  return {
    updateSession: (next) => view.rerender(
      <QueryClientProvider client={queryClient}><RelinkDialog session={next} onClose={onClose} /></QueryClientProvider>
    )
  }
}

function installSessionApi(startQr = vi.fn()): void {
  Object.defineProperty(window, 'warish', {
    configurable: true,
    value: {
      session: {
        startQr,
        requestPairingCode: vi.fn()
      }
    }
  })
}
