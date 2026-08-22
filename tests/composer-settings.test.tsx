// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { shouldFocusComposerForTyping, shouldSubmitComposer } from '../src/renderer/src/composer-keyboard'

function keyEvent(patch: Partial<Parameters<typeof shouldSubmitComposer>[0]> = {}): Parameters<typeof shouldSubmitComposer>[0] {
  return { key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, nativeEvent: { isComposing: false }, ...patch }
}

function typingKeyEvent(patch: Partial<Parameters<typeof shouldFocusComposerForTyping>[0]> = {}):
Parameters<typeof shouldFocusComposerForTyping>[0] {
  return {
    key: 'a', ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false,
    isComposing: false, target: document.body, getModifierState: () => false, ...patch
  }
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

describe('type-to-compose eligibility', () => {
  it('accepts printable characters and text-producing Shift or AltGraph modifiers', () => {
    const composer = document.createElement('textarea')
    expect(shouldFocusComposerForTyping(typingKeyEvent(), composer)).toBe(true)
    expect(shouldFocusComposerForTyping(typingKeyEvent({ key: 'A' }), composer)).toBe(true)
    expect(shouldFocusComposerForTyping(typingKeyEvent({
      key: '@', ctrlKey: true, altKey: true, getModifierState: (modifier) => modifier === 'AltGraph'
    }), composer)).toBe(true)
  })

  it('leaves commands, non-printable keys, and IME events alone', () => {
    const composer = document.createElement('textarea')
    for (const event of [
      typingKeyEvent({ key: 'f', ctrlKey: true }),
      typingKeyEvent({ key: 'f', metaKey: true }),
      typingKeyEvent({ key: 'f', altKey: true }),
      typingKeyEvent({ key: 'Enter' }),
      typingKeyEvent({ key: 'Process', isComposing: true }),
      typingKeyEvent({ keyCode: 229 }),
      typingKeyEvent({ defaultPrevented: true })
    ]) expect(shouldFocusComposerForTyping(event, composer)).toBe(false)
  })

  it('does not take typing from editable targets or Space activation from controls', () => {
    const composer = document.createElement('textarea')
    const input = document.createElement('input')
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const editableChild = document.createElement('span')
    editable.append(editableChild)
    const button = document.createElement('button')

    expect(shouldFocusComposerForTyping(typingKeyEvent({ target: input }), composer)).toBe(false)
    expect(shouldFocusComposerForTyping(typingKeyEvent({ target: editableChild }), composer)).toBe(false)
    expect(shouldFocusComposerForTyping(typingKeyEvent({ key: ' ', target: button }), composer)).toBe(false)
    expect(shouldFocusComposerForTyping(typingKeyEvent({ key: 'r', target: button }), composer)).toBe(true)
  })

  it('requires a writable composer and no open keyboard-owning layer', () => {
    const composer = document.createElement('textarea')
    expect(shouldFocusComposerForTyping(typingKeyEvent(), null)).toBe(false)
    composer.readOnly = true
    expect(shouldFocusComposerForTyping(typingKeyEvent(), composer)).toBe(false)
    composer.readOnly = false
    composer.disabled = true
    expect(shouldFocusComposerForTyping(typingKeyEvent(), composer)).toBe(false)
    composer.disabled = false
    expect(shouldFocusComposerForTyping(typingKeyEvent(), composer, true)).toBe(false)
  })
})
