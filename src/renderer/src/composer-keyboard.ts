export interface ComposerKeyEvent {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  nativeEvent: { isComposing?: boolean }
}

export function shouldSubmitComposer(event: ComposerKeyEvent, enterToSend: boolean): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && (enterToSend || event.ctrlKey || event.metaKey)
}

export interface TypeToComposeKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  defaultPrevented: boolean
  isComposing?: boolean
  keyCode?: number
  target: EventTarget | null
  getModifierState?(keyArg: string): boolean
}

const TEXT_EDITING_TARGET = [
  'input',
  'textarea',
  'select',
  '[role="textbox"]',
  '[contenteditable]:not([contenteditable="false"])'
].join(',')

const SPACE_ACTIVATED_TARGET = [
  'button',
  'a[href]',
  'summary',
  '[role="button"]',
  '[role="link"]',
  'audio[controls]',
  'video[controls]'
].join(',')

export function shouldFocusComposerForTyping(event: TypeToComposeKeyEvent, composer: HTMLTextAreaElement | null,
  keyboardLayerOpen = false): boolean {
  if (!composer || composer.disabled || composer.readOnly || composer.getAttribute('aria-disabled') === 'true') return false
  if (keyboardLayerOpen || event.defaultPrevented || event.isComposing || event.keyCode === 229) return false
  if (event.key === 'Process' || event.key === 'Unidentified' || event.key === 'Dead') return false
  if ([...event.key].length !== 1) return false

  const altGraph = event.getModifierState?.('AltGraph') ?? false
  if ((event.ctrlKey || event.metaKey || event.altKey) && !altGraph) return false

  const target = event.target instanceof Element ? event.target : undefined
  if (target?.closest(TEXT_EDITING_TARGET)) return false
  if (event.key === ' ' && target?.closest(SPACE_ACTIVATED_TARGET)) return false
  return true
}
