import { describe, expect, it } from 'vitest'
import type { ChatSummary } from '../src/shared/contracts'
import { contactIdentityPresentation } from '../src/renderer/src/contact-identity'

function chat(patch: Partial<ChatSummary> = {}): ChatSummary {
  return { id: 'contact-1', title: 'Unknown contact', kind: 'direct', unreadCount: 0, archived: false, pinned: false, ...patch }
}

describe('contact identity presentation', () => {
  it('shows a saved name without a phone line and keeps a distinct WhatsApp profile pill', () => {
    expect(contactIdentityPresentation(chat({
      title: 'A saved name', savedName: 'A saved name', phoneNumber: '+447700900111', whatsappName: 'WhatsApp profile'
    }))).toEqual({
      primary: 'A saved name', profileName: 'WhatsApp profile', hasSecondary: true
    })
  })

  it('uses the number for an unsaved contact without repeating it beneath the title', () => {
    expect(contactIdentityPresentation(chat({
      title: '+919876543210', phoneNumber: '+919876543210', whatsappName: 'Unsaved profile'
    }))).toEqual({ primary: '+919876543210', profileName: 'Unsaved profile', hasSecondary: true })
  })

  it('suppresses duplicate profile names and empty secondary content', () => {
    expect(contactIdentityPresentation(chat({ title: 'Same name', savedName: 'Same name', whatsappName: 'Same name' })))
      .toEqual({ primary: 'Same name', profileName: undefined, hasSecondary: false })
  })

  it('keeps a WhatsApp profile name pill-only when no phone number is available', () => {
    expect(contactIdentityPresentation(chat({ title: 'Profile only', whatsappName: 'Profile only' })))
      .toEqual({ primary: 'Unknown contact', profileName: 'Profile only', hasSecondary: true })
  })

  it('leaves non-direct conversation titles unchanged', () => {
    expect(contactIdentityPresentation(chat({ kind: 'group', title: 'Project group' })))
      .toEqual({ primary: 'Project group', hasSecondary: false })
  })
})
