import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, KeyRound, LoaderCircle, QrCode, Settings } from 'lucide-react'
import type { SessionState } from '../../../shared/contracts'
import { useUiStore } from '../store'
import { BrandMark } from './BrandMark'

export function Onboarding({ session }: { session: SessionState }): React.JSX.Element {
  const [phone, setPhone] = useState('')
  const [historyChoice, setHistoryChoice] = useState<'1' | '7' | 'custom'>('7')
  const [customDays, setCustomDays] = useState('30')
  const queryClient = useQueryClient()
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen)
  const saveHistoryWindow = async (): Promise<void> => {
    const days = historyChoice === 'custom' ? Number(customDays) : Number(historyChoice)
    if (!Number.isInteger(days) || days < 1 || days > 3_650) throw new Error('Enter a history window between 1 and 3,650 days')
    const settings = await window.warish.settings.update({ historySyncDays: days })
    queryClient.setQueryData(['settings'], settings)
  }
  const qrMutation = useMutation({
    mutationFn: async () => { await saveHistoryWindow(); return window.warish.session.startQr() },
    onSuccess: (state) => queryClient.setQueryData(['session'], state)
  })
  const codeMutation = useMutation({
    mutationFn: async () => { await saveHistoryWindow(); return window.warish.session.requestPairingCode(phone) },
    onSuccess: (state) => queryClient.setQueryData(['session'], state)
  })
  const error = qrMutation.error ?? codeMutation.error
  const visibleError = error instanceof Error ? error.message : session.message

  return (
    <main className="onboarding">
      <button className="icon-button onboarding-settings" title="Settings" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Settings size={20} /></button>
      <section className="onboarding-card">
        <div className="brand-lockup"><BrandMark /><div><h1>Welcome to WArish</h1><p>Your conversations stay on this computer.</p></div></div>
        {session.phase === 'pairing' && session.qrDataUrl ? (
          <div className="pairing-view">
            <img className="qr-code" src={session.qrDataUrl} alt="WhatsApp linked-device QR code" />
            <div><h2>Scan with your phone</h2><ol><li>Open WhatsApp on your phone</li><li>Open Linked devices</li><li>Choose Link a device and scan this code</li></ol></div>
          </div>
        ) : session.pairingCode ? (
          <div className="code-view"><KeyRound size={28} /><p>Enter this code on your phone</p><strong>{formatPairingCode(session.pairingCode)}</strong></div>
        ) : (
          <>
            <div className="privacy-note"><strong>Before linking</strong><p>WArish is an unofficial client. Use the dedicated test number while developing and avoid automated or unsolicited messaging.</p></div>
            <div className="pairing-actions">
              <div className="history-picker">
                <div className="history-heading"><CalendarDays /><div><strong>How much message history?</strong><span>Only messages inside this window will be saved on this computer.</span></div></div>
                <div className="history-options">
                  <button aria-pressed={historyChoice === '1'} className={historyChoice === '1' ? 'active' : ''} onClick={() => setHistoryChoice('1')}><strong>1 day</strong><span>Fastest</span></button>
                  <button aria-pressed={historyChoice === '7'} className={historyChoice === '7' ? 'active' : ''} onClick={() => setHistoryChoice('7')}><strong>1 week</strong><span>Recommended</span></button>
                  <button aria-pressed={historyChoice === 'custom'} className={historyChoice === 'custom' ? 'active' : ''} onClick={() => setHistoryChoice('custom')}><strong>Custom</strong><span>Choose days</span></button>
                </div>
                {historyChoice === 'custom' && <label className="custom-days"><span>Number of days</span><input type="number" min="1" max="3650" value={customDays} onChange={(event) => setCustomDays(event.target.value)} /></label>}
                <small>Windows longer than one week request a deeper WhatsApp history sync and may take more time.</small>
              </div>
              <button className="primary-button large" onClick={() => qrMutation.mutate()} disabled={qrMutation.isPending}>
                {qrMutation.isPending ? <LoaderCircle className="spin" /> : <QrCode />} Link with QR code
              </button>
              <div className="divider"><span>or use your phone number</span></div>
              <div className="phone-code-row"><input aria-label="International phone number" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="International number, e.g. 15551234567" /><button onClick={() => codeMutation.mutate()} disabled={!phone || codeMutation.isPending}>Get code</button></div>
            </div>
          </>
        )}
        {visibleError && <p className="error-text">{visibleError}</p>}
      </section>
    </main>
  )
}

function formatPairingCode(code: string): string { return code.replace(/(.{4})/g, '$1 ').trim() }
