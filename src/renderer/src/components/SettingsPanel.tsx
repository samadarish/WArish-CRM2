import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import {
  ArrowLeft, Bell, Check, Circle, ClipboardCopy, Database, HardDrive, Keyboard, LayoutList, LoaderCircle,
  LogOut, Maximize2, MessageSquare, Minimize2, Moon, Palette, RefreshCw, RotateCcw, ScrollText, Sun,
  Trash2, TriangleAlert, X
} from 'lucide-react'
import type { AppSettings, ContactSyncState, DiagnosticsDto, LogEntryDto } from '../../../shared/contracts'
import { useUiStore } from '../store'

type SettingsSection = 'appearance' | 'messaging' | 'notifications' | 'storage' | 'diagnostics' | 'account'

const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string; icon: ReactNode }> = [
  { id: 'appearance', label: 'Appearance', icon: <Palette /> },
  { id: 'messaging', label: 'Messaging', icon: <MessageSquare /> },
  { id: 'notifications', label: 'Notifications', icon: <Bell /> },
  { id: 'storage', label: 'Storage & contacts', icon: <HardDrive /> },
  { id: 'diagnostics', label: 'Diagnostics', icon: <ScrollText /> },
  { id: 'account', label: 'Account', icon: <LogOut /> }
]

export function SettingsPanel(): React.JSX.Element {
  const close = useUiStore((state) => state.setSettingsOpen)
  const pushNotice = useUiStore((state) => state.pushNotice)
  const [activeSection, setActiveSection] = useState<SettingsSection>('appearance')
  const [logsOpen, setLogsOpen] = useState(false)
  const [copyStatus, setCopyStatus] = useState('')
  const [confirmAction, setConfirmAction] = useState<'unlink' | 'reset'>()
  const [accountPending, setAccountPending] = useState(false)
  const copyTimer = useRef<number | undefined>(undefined)
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: () => window.warish.settings.get() })
  const diagnosticsQuery = useQuery({ queryKey: ['diagnostics'], queryFn: () => window.warish.diagnostics.get() })
  const contactSyncQuery = useQuery({ queryKey: ['contact-sync'], queryFn: () => window.warish.contacts.getSyncState() })
  const logsQuery = useQuery({ queryKey: ['diagnostic-logs'], queryFn: () => window.warish.diagnostics.logs(200), enabled: logsOpen })
  const update = useMutation({
    mutationFn: (patch: Partial<AppSettings>) => window.warish.settings.update(patch),
    onSuccess: (settings) => queryClient.setQueryData(['settings'], settings),
    onError: (error) => pushNotice(error instanceof Error ? error.message : 'Could not save settings')
  })
  const refreshContacts = useMutation({
    mutationFn: () => window.warish.contacts.refresh(),
    onSuccess: async (state) => {
      queryClient.setQueryData<ContactSyncState>(['contact-sync'], state)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['chats'] }),
        queryClient.invalidateQueries({ queryKey: ['communities'] }),
        diagnosticsQuery.refetch()
      ])
      pushNotice(state.state === 'complete' ? 'Contact names refreshed' : state.message ?? 'Contact refresh completed with some gaps', 'info')
    },
    onError: (error) => pushNotice(error instanceof Error ? error.message : 'Could not refresh contact names')
  })
  const settings = settingsQuery.data
  const contactRefreshAvailable = diagnosticsQuery.data?.sessionPhase === 'connected'
  const sectionLabel = SETTINGS_SECTIONS.find((section) => section.id === activeSection)?.label ?? 'Settings'

  const logout = async (): Promise<void> => {
    setAccountPending(true)
    try {
      if (confirmAction === 'reset') {
        await window.warish.application.resetLocalData()
        return
      }
      await window.warish.session.logout(false)
      close(false)
      await queryClient.invalidateQueries()
    } catch (error) { pushNotice(error instanceof Error ? error.message : 'Could not unlink the account') }
    finally { setAccountPending(false); setConfirmAction(undefined) }
  }
  const copyLogs = async (): Promise<void> => {
    const text = (logsQuery.data ?? []).map((entry) =>
      `[${new Date(entry.timestamp).toISOString()}] ${entry.level.toUpperCase()} ${entry.message}${entry.context ? `\n${entry.context}` : ''}`
    ).join('\n\n')
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopyStatus('Copied')
    } catch { setCopyStatus('Copy failed') }
    if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopyStatus(''), 1_500)
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (confirmAction) setConfirmAction(undefined)
      else if (logsOpen) setLogsOpen(false)
      else close(false)
    }
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('keydown', escape)
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
    }
  }, [close, confirmAction, logsOpen])

  return <div className="modal-backdrop settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(false) }}>
    <aside className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header>
        {logsOpen && <button className="icon-button settings-back-button" onClick={() => setLogsOpen(false)} aria-label="Back to settings"><ArrowLeft /></button>}
        <div><span className="settings-eyebrow">Workspace preferences</span><h2 id="settings-title">{logsOpen ? 'Error logs' : sectionLabel}</h2></div>
        <button className="icon-button" onClick={() => close(false)} aria-label="Close settings"><X /></button>
      </header>
      {logsOpen ? <LogViewer query={logsQuery} copyStatus={copyStatus} onCopy={() => void copyLogs()} />
        : settingsQuery.isError ? <div className="settings-query-state query-error" role="alert"><TriangleAlert /><span>Could not load settings.</span><button className="secondary-button" onClick={() => void settingsQuery.refetch()}>Try again</button></div>
          : !settings ? <div className="settings-query-state loading-row"><LoaderCircle className="spin" />Loading settings…</div>
            : <div className="settings-layout">
              <nav className="settings-nav" aria-label="Settings categories">{SETTINGS_SECTIONS.map((section) =>
                <button key={section.id} className={activeSection === section.id ? 'active' : ''} aria-current={activeSection === section.id ? 'page' : undefined}
                  onClick={() => setActiveSection(section.id)}>{section.icon}<span>{section.label}</span></button>)}</nav>
              <div className="settings-content">
                {activeSection === 'appearance' && <AppearanceSettings settings={settings} pending={update.isPending} update={(patch) => update.mutate(patch)} />}
                {activeSection === 'messaging' && <MessagingSettings settings={settings} update={(patch) => update.mutate(patch)} />}
                {activeSection === 'notifications' && <NotificationSettings settings={settings} update={(patch) => update.mutate(patch)} />}
                {activeSection === 'storage' && <StorageSettings settings={settings} contactSync={contactSyncQuery.data}
                  contactRefreshAvailable={contactRefreshAvailable} refreshPending={refreshContacts.isPending}
                  onRefresh={() => refreshContacts.mutate()} onUpdate={(patch) => update.mutate(patch)}
                  onClearCache={() => void window.warish.media.clearCache().then(() => { pushNotice('Downloaded media cleared', 'info'); void diagnosticsQuery.refetch() })
                    .catch((error) => pushNotice(error instanceof Error ? error.message : 'Could not clear downloaded media'))} />}
                {activeSection === 'diagnostics' && <DiagnosticsSettings diagnostics={diagnosticsQuery.data} onOpenLogs={() => setLogsOpen(true)} />}
                {activeSection === 'account' && <AccountSettings onUnlink={() => setConfirmAction('unlink')} onReset={() => setConfirmAction('reset')} />}
              </div>
            </div>}
      {confirmAction && <div className="modal-backdrop nested-confirm"><section className="modal action-dialog" role="alertdialog" aria-modal="true" aria-labelledby="account-confirm-title">
        <header><div className="dialog-icon danger"><TriangleAlert /></div><h2 id="account-confirm-title">{confirmAction === 'reset' ? 'Reset WArish completely?' : 'Unlink this account?'}</h2><button className="icon-button" aria-label="Cancel" onClick={() => setConfirmAction(undefined)}><X /></button></header>
        <div className="action-dialog-content"><p>{confirmAction === 'reset'
          ? 'This removes the account, history, media, drafts, backups, logs, and preferences, then restarts WArish.'
          : 'WhatsApp will be unlinked, but local history and preferences will remain on this computer.'}</p>
          <footer><button onClick={() => setConfirmAction(undefined)}>Cancel</button><button className={confirmAction === 'reset' ? 'danger-button' : 'primary-button'} disabled={accountPending} onClick={() => void logout()}>{accountPending ? 'Working…' : confirmAction === 'reset' ? 'Erase and restart' : 'Unlink account'}</button></footer></div>
      </section></div>}
    </aside>
  </div>
}

function AppearanceSettings({ settings, pending, update }: { settings: AppSettings; pending: boolean; update(patch: Partial<AppSettings>): void }): React.JSX.Element {
  return <>
    <SettingsHeading title="Appearance" description="Choose how your workspace looks and how much information it shows." />
    <SettingGroup title="Theme">
      <div className="option-grid theme-options">{(['system', 'light', 'dark', 'black'] as const).map((theme) =>
        <OptionButton key={theme} active={settings.theme === theme} disabled={pending} label={theme} onClick={() => update({ theme })}
          icon={theme === 'light' ? <Sun /> : theme === 'dark' ? <Moon /> : theme === 'black' ? <Circle className="black-theme-icon" /> : <RotateCcw />} />)}</div>
    </SettingGroup>
    <SettingGroup title="Layout density" description="Compact reduces whitespace and control size while keeping text fully readable.">
      <div className="option-grid density-options">{(['compact', 'comfortable'] as const).map((density) =>
        <OptionButton key={density} active={settings.density === density} disabled={pending} label={density} onClick={() => update({ density })}
          icon={density === 'compact' ? <Minimize2 /> : <Maximize2 />} />)}</div>
    </SettingGroup>
    <SettingGroup title="Navigation rail" description="Auto adapts the rail to the available window width.">
      <div className="option-grid navigation-options">{(['auto', 'expanded', 'collapsed'] as const).map((navigationMode) =>
        <OptionButton key={navigationMode} active={settings.navigationMode === navigationMode} disabled={pending} label={navigationMode}
          onClick={() => update({ navigationMode })} icon={navigationMode === 'auto' ? <RotateCcw /> : navigationMode === 'expanded' ? <Maximize2 /> : <Minimize2 />} />)}</div>
    </SettingGroup>
    <SettingGroup title="Conversation canvas" description="Select a restrained backdrop that works across every theme.">
      <div className="background-options">{(['subtle', 'plain', 'grid'] as const).map((conversationBackground) =>
        <button key={conversationBackground} className={`background-option ${conversationBackground} ${settings.conversationBackground === conversationBackground ? 'active' : ''}`}
          aria-pressed={settings.conversationBackground === conversationBackground} onClick={() => update({ conversationBackground })}>
          <span className="background-swatch">{settings.conversationBackground === conversationBackground && <Check />}</span><strong>{conversationBackground}</strong>
        </button>)}</div>
    </SettingGroup>
    <SettingToggle label="Reduce animations" description="Limit transitions and motion throughout the interface." checked={settings.reduceMotion} onChange={(reduceMotion) => update({ reduceMotion })} />
  </>
}

function MessagingSettings({ settings, update }: { settings: AppSettings; update(patch: Partial<AppSettings>): void }): React.JSX.Element {
  return <>
    <SettingsHeading title="Messaging" description="Control how conversations are displayed and how messages are sent." />
    <div className="settings-card">
      <SettingToggle icon={<Keyboard />} label="Enter to send" description="Press Enter to send. Shift+Enter always starts a new line." checked={settings.enterToSend} onChange={(enterToSend) => update({ enterToSend })} />
      <SettingToggle icon={<LayoutList />} label="Show chat previews" description="Display the latest message under each conversation name." checked={settings.showChatPreviews} onChange={(showChatPreviews) => update({ showChatPreviews })} />
    </div>
    <div className="settings-note"><Keyboard /><div><strong>Keyboard tip</strong><span>{settings.enterToSend ? 'Use Shift+Enter for a new line, or turn this off to make Enter insert a line break.' : 'Use Ctrl+Enter or Cmd+Enter whenever you want to send.'}</span></div></div>
  </>
}

function NotificationSettings({ settings, update }: { settings: AppSettings; update(patch: Partial<AppSettings>): void }): React.JSX.Element {
  return <>
    <SettingsHeading title="Notifications" description="Manage what WArish shows when you are working elsewhere." />
    <div className="settings-card">
      <SettingToggle icon={<MessageSquare />} label="Show message previews" description="Include the sender and message text in Windows notifications." checked={settings.notificationPreview} onChange={(notificationPreview) => update({ notificationPreview })} />
      <SettingToggle icon={<RotateCcw />} label="Start with Windows" description="Launch WArish in the tray after signing in." checked={settings.launchAtLogin} onChange={(launchAtLogin) => update({ launchAtLogin })} />
    </div>
  </>
}

function StorageSettings({ settings, contactSync, contactRefreshAvailable, refreshPending, onRefresh, onUpdate, onClearCache }: {
  settings: AppSettings; contactSync?: ContactSyncState; contactRefreshAvailable: boolean; refreshPending: boolean
  onRefresh(): void; onUpdate(patch: Partial<AppSettings>): void; onClearCache(): void
}): React.JSX.Element {
  const running = contactSync?.state === 'running'
  return <>
    <SettingsHeading title="Storage & contacts" description="Manage downloaded files and keep conversation identities current." />
    <SettingGroup title="Media storage">
      <label className="select-setting settings-card"><span><strong>Media cache limit</strong><small>Older downloaded media is removed automatically.</small></span><select value={settings.cacheLimitBytes} onChange={(event) => onUpdate({ cacheLimitBytes: Number(event.target.value) })}><option value={1024 ** 3}>1 GB</option><option value={5 * 1024 ** 3}>5 GB</option><option value={10 * 1024 ** 3}>10 GB</option></select></label>
      <button className="secondary-button" onClick={onClearCache}><Trash2 />Clear downloaded media</button>
    </SettingGroup>
    <SettingGroup title="Contact directory">
      <div className="contact-sync-summary"><div><strong>{contactSync?.resolvedNames ?? 0} named chats</strong><span>{contactSync?.resolvedPhones ?? 0} phone numbers resolved</span></div>{contactSync?.message && <small>{contactSync.message}</small>}{running && <progress max={Math.max(1, contactSync.total)} value={contactSync.processed} />}</div>
      <button className="secondary-button" disabled={!contactRefreshAvailable || refreshPending || running} onClick={onRefresh}><RefreshCw className={refreshPending || running ? 'spin' : ''} />{refreshPending || running ? 'Refreshing contact names…' : contactRefreshAvailable ? 'Refresh contact names' : 'Connect WhatsApp to refresh'}</button>
    </SettingGroup>
  </>
}

function DiagnosticsSettings({ diagnostics, onOpenLogs }: { diagnostics: DiagnosticsDto | undefined; onOpenLogs(): void }): React.JSX.Element {
  return <>
    <SettingsHeading title="Diagnostics" description="Review local app health and information useful for troubleshooting." />
    {!diagnostics ? <div className="loading-row"><LoaderCircle className="spin" />Loading diagnostics…</div> : <div className="diagnostic-grid">
      <span><Database />Database <b>{formatBytes(diagnostics.databaseBytes)}</b></span><span><HardDrive />Media <b>{formatBytes(diagnostics.mediaCacheBytes)}</b></span>
      <span>App version <b>v{diagnostics.appVersion}</b></span><span>Session <b>{diagnostics.sessionPhase}</b></span>
      <span>Named chats <b>{diagnostics.identityCoverage.resolvedNames}/{diagnostics.identityCoverage.directChats}</b></span><span>Avatars <b>{diagnostics.identityCoverage.cachedAvatars}</b></span>
      <span>Avatar errors <b>{diagnostics.identityCoverage.failedAvatarRequests}</b></span>
    </div>}
    <button className="secondary-button" onClick={onOpenLogs}><ScrollText />View error logs</button>
  </>
}

function AccountSettings({ onUnlink, onReset }: { onUnlink(): void; onReset(): void }): React.JSX.Element {
  return <>
    <SettingsHeading title="Account" description="Manage the linked WhatsApp session and local application data." />
    <div className="settings-card account-action"><div><strong>Linked WhatsApp account</strong><span>Unlink the session while keeping local history and preferences.</span></div><button className="secondary-button" onClick={onUnlink}><LogOut />Unlink</button></div>
    <div className="settings-card account-action danger"><div><strong>Full fresh reset</strong><span>Erase the account, history, media, logs, drafts, and every preference.</span></div><button className="danger-button" onClick={onReset}><Trash2 />Reset WArish</button></div>
  </>
}

function LogViewer({ query, copyStatus, onCopy }: {
  query: UseQueryResult<LogEntryDto[], Error>
  copyStatus: string; onCopy(): void
}): React.JSX.Element {
  return <div className="settings-content log-viewer"><div className="log-toolbar"><button className="secondary-button" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw className={query.isFetching ? 'spin' : ''} />Refresh</button><button className="secondary-button" onClick={onCopy} disabled={!query.data?.length}><ClipboardCopy />{copyStatus || 'Copy all'}</button></div>
    {query.isLoading ? <div className="loading-row"><LoaderCircle className="spin" />Loading logs…</div>
      : query.isError ? <div className="log-empty error-text"><TriangleAlert />Could not read the application logs.</div>
        : !query.data?.length ? <div className="log-empty"><ScrollText /><strong>No errors recorded</strong><span>Warnings and errors will appear here if WArish encounters a problem.</span></div>
          : <div className="log-list">{query.data.map((entry, index) => <article className={`log-entry ${entry.level}`} key={`${entry.timestamp}:${index}`}><header><span>{entry.level}</span><time>{formatLogTime(entry.timestamp)}</time></header><strong>{entry.message}</strong>{entry.context && <pre>{entry.context}</pre>}</article>)}</div>}
  </div>
}

function SettingsHeading({ title, description }: { title: string; description: string }): React.JSX.Element {
  return <div className="settings-heading"><h3>{title}</h3><p>{description}</p></div>
}
function SettingGroup({ title, description, children }: { title: string; description?: string; children: ReactNode }): React.JSX.Element {
  return <section className="setting-group"><div className="setting-group-heading"><strong>{title}</strong>{description && <span>{description}</span>}</div>{children}</section>
}
function OptionButton({ active, disabled, label, icon, onClick }: { active: boolean; disabled?: boolean; label: string; icon: ReactNode; onClick(): void }): React.JSX.Element {
  return <button disabled={disabled} aria-pressed={active} className={active ? 'active' : ''} onClick={onClick}>{icon}<span>{label}</span>{active && <Check className="option-check" />}</button>
}
function SettingToggle({ icon, label, description, checked, onChange }: { icon?: ReactNode; label: string; description: string; checked: boolean; onChange(value: boolean): void }): React.JSX.Element {
  return <label className="toggle-setting">{icon && <span className="setting-icon">{icon}</span>}<span><strong>{label}</strong><small>{description}</small></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i /></label>
}
function formatBytes(bytes: number): string { if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`; return `${(bytes / 1024 ** 3).toFixed(1)} GB` }
function formatLogTime(timestamp: number): string { return timestamp ? new Date(timestamp).toLocaleString() : 'Unknown time' }
