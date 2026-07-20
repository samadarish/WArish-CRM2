import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

export function useDialogFocus<T extends HTMLElement>(onClose: () => void, closeOnEscape = true): RefObject<T | null> {
  const dialogRef = useRef<T>(null)
  const onCloseRef = useRef(onClose)
  const closeOnEscapeRef = useRef(closeOnEscape)
  const returnFocusRef = useRef<HTMLElement | undefined>(
    document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  )

  useEffect(() => { onCloseRef.current = onClose }, [onClose])
  useEffect(() => { closeOnEscapeRef.current = closeOnEscape }, [closeOnEscape])

  useEffect(() => {
    const returnFocus = returnFocusRef.current
    const focusTimer = window.setTimeout(() => {
      const dialog = dialogRef.current
      if (!dialog || dialog.contains(document.activeElement)) return
      const initialFocus = dialog.querySelector<HTMLElement>('[autofocus]') ??
        dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? dialog
      initialFocus.focus()
    })
    const handleKeyDown = (event: KeyboardEvent): void => {
      const dialog = dialogRef.current
      if (!dialog || !isTopmostDialog(dialog)) return
      if (event.key === 'Escape' && closeOnEscapeRef.current) {
        event.preventDefault()
        event.stopImmediatePropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
      if (!focusable.length) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]!
      const last = focusable.at(-1)!
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', handleKeyDown)
      window.queueMicrotask(() => {
        if (returnFocus?.isConnected) returnFocus.focus()
      })
    }
  }, [])

  return dialogRef
}

function isTopmostDialog(dialog: HTMLElement): boolean {
  const dialogs = [...document.querySelectorAll<HTMLElement>(
    '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'
  )]
  return dialogs.at(-1) === dialog
}
