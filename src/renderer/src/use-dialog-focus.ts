import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

export function useDialogFocus<T extends HTMLElement>(onClose: () => void, closeOnEscape = true,
  returnFocusTarget?: HTMLElement): RefObject<T | null> {
  const dialogRef = useRef<T>(null)
  const onCloseRef = useRef(onClose)
  const closeOnEscapeRef = useRef(closeOnEscape)
  const returnFocusRef = useRef<HTMLElement | undefined>(returnFocusTarget ?? resolveReturnFocus())

  useEffect(() => { onCloseRef.current = onClose }, [onClose])
  useEffect(() => { closeOnEscapeRef.current = closeOnEscape }, [closeOnEscape])

  useEffect(() => {
    const returnFocus = returnFocusRef.current
    const returnFocusId = returnFocus?.id
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
        if (event.defaultPrevented || document.querySelector('.ui-popover')) return
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
      window.setTimeout(() => {
        const target = returnFocus?.isConnected ? returnFocus
          : returnFocusId ? document.getElementById(returnFocusId) : undefined
        const focusGroup = target?.closest<HTMLElement>('[data-focus-return-group]')
        if (focusGroup) focusGroup.dataset.focusRestoring = 'true'
        target?.focus({ preventScroll: true })
        if (focusGroup) window.requestAnimationFrame(() => { delete focusGroup.dataset.focusRestoring })
      }, 0)
    }
  }, [])

  return dialogRef
}

function resolveReturnFocus(): HTMLElement | undefined {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  if (!active?.matches('[role="menuitem"]')) return active
  const expandedTriggers = [...document.querySelectorAll<HTMLElement>('[aria-haspopup][aria-expanded="true"]')]
  return expandedTriggers.at(-1) ?? active
}

function isTopmostDialog(dialog: HTMLElement): boolean {
  const dialogs = [...document.querySelectorAll<HTMLElement>(
    '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'
  )]
  return dialogs.at(-1) === dialog
}
