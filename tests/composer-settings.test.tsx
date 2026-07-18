import { describe, expect, it } from 'vitest'
import { shouldSubmitComposer } from '../src/renderer/src/composer-keyboard'

function keyEvent(patch: Partial<Parameters<typeof shouldSubmitComposer>[0]> = {}): Parameters<typeof shouldSubmitComposer>[0] {
  return { key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, nativeEvent: { isComposing: false }, ...patch }
}

describe('composer send preference', () => {
  it('sends with Enter and reserves Shift+Enter for a new line when enabled', () => {
    expect(shouldSubmitComposer(keyEvent(), true)).toBe(true)
    expect(shouldSubmitComposer(keyEvent({ shiftKey: true }), true)).toBe(false)
  })

  it('requires Ctrl+Enter or Cmd+Enter when Enter-to-send is disabled', () => {
    expect(shouldSubmitComposer(keyEvent(), false)).toBe(false)
    expect(shouldSubmitComposer(keyEvent({ ctrlKey: true }), false)).toBe(true)
    expect(shouldSubmitComposer(keyEvent({ metaKey: true }), false)).toBe(true)
  })

  it('does not submit while an input method editor is composing', () => {
    expect(shouldSubmitComposer(keyEvent({ nativeEvent: { isComposing: true } }), true)).toBe(false)
  })
})
