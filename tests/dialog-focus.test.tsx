// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { useDialogFocus } from '../src/renderer/src/use-dialog-focus'

afterEach(cleanup)

function Dialog({ onClose }: { onClose(): void }): React.JSX.Element {
  const dialogRef = useDialogFocus<HTMLElement>(onClose)
  return <section ref={dialogRef} role="dialog" aria-modal="true" aria-label="Test dialog" tabIndex={-1}>
    <button autoFocus>First action</button>
    <button>Last action</button>
  </section>
}

function Harness(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return <><button onClick={() => setOpen(true)}>Open dialog</button>{open && <Dialog onClose={() => setOpen(false)} />}</>
}

function NestedOverlayHarness(): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [popoverOpen, setPopoverOpen] = useState(true)
  return <>{open && <Dialog onClose={() => setOpen(false)} />}{popoverOpen && createPortal(
    <div className="ui-popover"><button onClick={() => setPopoverOpen(false)}>Popover action</button></div>, document.body
  )}</>
}

describe('useDialogFocus', () => {
  it('keeps Tab inside the active dialog and restores focus after Escape', async () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open dialog' })
    opener.focus()
    fireEvent.click(opener)
    const first = screen.getByRole('button', { name: 'First action' })
    const last = screen.getByRole('button', { name: 'Last action' })
    await waitFor(() => expect(first).toHaveFocus())

    opener.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(first).toHaveFocus()
    last.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('leaves the parent dialog open while a portaled child overlay handles Escape', () => {
    render(<NestedOverlayHarness />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: 'Test dialog' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Popover action' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Test dialog' })).not.toBeInTheDocument()
  })
})
