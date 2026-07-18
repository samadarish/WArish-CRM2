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
