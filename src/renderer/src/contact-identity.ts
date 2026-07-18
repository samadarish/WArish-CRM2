import type { ChatSummary } from '../../shared/contracts'

export interface ContactIdentityPresentation {
  primary: string
  profileName?: string
  hasSecondary: boolean
}

export function contactIdentityPresentation(chat: ChatSummary): ContactIdentityPresentation {
  if (chat.kind !== 'direct') return { primary: chat.title, hasSecondary: false }
  const savedName = cleanValue(chat.savedName)
  const phoneNumber = cleanValue(chat.phoneNumber)
  const whatsappName = cleanValue(chat.whatsappName)
  const storedTitle = cleanValue(chat.title)
  const primary = savedName ?? phoneNumber ?? (storedTitle !== whatsappName ? storedTitle : undefined) ?? 'Unknown contact'
  const profileName = whatsappName && whatsappName !== savedName && whatsappName !== phoneNumber ? whatsappName : undefined
  return { primary, profileName, hasSecondary: Boolean(profileName) }
}

function cleanValue(value?: string): string | undefined {
  const cleaned = value?.trim()
  return cleaned || undefined
}
