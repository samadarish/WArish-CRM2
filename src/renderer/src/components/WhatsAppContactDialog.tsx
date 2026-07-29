import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ContactRound, LoaderCircle, Save, X } from 'lucide-react'
import type { ContactDetails } from '../../../shared/contracts'
import { useUiStore } from '../store'
import { useDialogFocus } from '../use-dialog-focus'
import { IconButton } from './ui-primitives'

export function WhatsAppContactDialog({ chatId, initialName, phoneNumber, saved, onClose }: {
  chatId: string
  initialName: string
  phoneNumber?: string
  saved: boolean
  onClose(): void
}): React.JSX.Element {
  const [fullName, setFullName] = useState(initialName)
  const queryClient = useQueryClient()
  const pushNotice = useUiStore((state) => state.pushNotice)
  const save = useMutation({
    mutationFn: () => window.warish.contacts.save(chatId, { fullName }),
    onSuccess: async (details) => {
      queryClient.setQueryData<ContactDetails>(['contact', chatId], details)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['chat', chatId] }),
        queryClient.invalidateQueries({ queryKey: ['chats'] }),
        queryClient.invalidateQueries({ queryKey: ['communities'] })
      ])
      pushNotice('Saved through WhatsApp', 'info')
      onClose()
    },
    onError: (error) => pushNotice(error instanceof Error ? error.message : 'Could not save this WhatsApp contact')
  })
  const dialogRef = useDialogFocus<HTMLElement>(onClose, !save.isPending)
  return <div className="modal-backdrop crm-dialog-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !save.isPending) onClose()
  }}><section ref={dialogRef} className="modal crm-dialog whatsapp-contact-dialog" role="dialog" aria-modal="true"
    aria-labelledby="whatsapp-contact-title" tabIndex={-1}>
    <header><div><span>WhatsApp contact</span><h2 id="whatsapp-contact-title">{saved ? 'Edit saved contact' : 'Save new contact'}</h2></div>
      <IconButton label="Close contact dialog" disabled={save.isPending} onClick={onClose}><X /></IconButton></header>
    <div className="crm-dialog-body"><form className="crm-form" onSubmit={(event) => { event.preventDefault(); if (fullName.trim()) save.mutate() }}>
      <div className="whatsapp-contact-summary"><ContactRound /><div><strong>{phoneNumber ?? 'WhatsApp contact'}</strong><span>Saved names sync through your linked WhatsApp account.</span></div></div>
      <label className="form-field"><span>Contact name</span><input autoFocus maxLength={160} value={fullName}
        onChange={(event) => setFullName(event.target.value)} required /></label>
      <footer><button type="button" className="secondary-button" disabled={save.isPending} onClick={onClose}>Cancel</button>
        <button className="primary-button" disabled={!fullName.trim() || save.isPending}>{save.isPending ? <LoaderCircle className="spin" /> : <Save />}
          {save.isPending ? 'Saving…' : saved ? 'Save changes' : 'Save contact'}</button></footer>
    </form></div>
  </section></div>
}
