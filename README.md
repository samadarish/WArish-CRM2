# WArish

WArish is a Windows-first, local-first WhatsApp CRM desktop client built with Electron, React, TypeScript, SQLite, and Baileys. Messaging and CRM data share a typed local core while remaining isolated from the sandboxed renderer.

> WArish uses WhatsApp's undocumented linked-device protocol through Baileys. It is not affiliated with or supported by WhatsApp/Meta. Protocol changes can break connectivity, and using unofficial clients may carry account risk. Develop with a dedicated test number and do not automate unsolicited messaging.

## Current feature set

- Link one WhatsApp account by QR code or phone-number pairing code
- User-selected history sync window (1 day, 1 week, or custom days) with full-text search
- On-demand 50-message history pages after the selected initial window is exhausted
- Direct, group, Community, and read-only Channel conversations
- Text, image, video, document, audio, voice-note, and sticker sending
- Replies, reactions, forwarding, editing, deletion, and read receipts
- On-demand encrypted-source media downloads with a configurable LRU-style cache
- Contact pipeline, notes, follow-up tasks, source-message references, catalog items, orders, and payments
- Searchable and virtualized CRM contact, order, task, and catalog workspaces
- Windows notifications, system tray, close-to-tray, optional startup, five themes, and four density modes
- Per-chat text and attachment drafts with explicit retry for failed outgoing messages
- Encrypted Baileys credentials and raw message envelopes using a Windows DPAPI-protected master key

Calls, Status posts, broadcasts, and multi-account support are intentionally outside this release.

## Architecture

```text
React renderer (sandboxed)
        │ typed IPC through preload
Electron main ── Windows tray / notifications / secureStorage / file dialogs
        │ MessagePort
Utility process ── Baileys ── WhatsApp linked-device connection
        ├── node:sqlite (WAL, FTS5)
        └── encrypted auth + smart media cache
```

The Baileys/SQLite core runs outside the renderer, and the renderer has no Node.js access. This keeps protocol state and credentials out of the web UI and gives messaging and CRM workflows a stable RPC boundary.

## Development

Use native Windows PowerShell or Command Prompt. Node `22.22.2` through Node `24` is supported for development; `.node-version` pins Node `24.18.0` for reproducible CI builds. The packaged application uses Electron's embedded Node runtime for SQLite.

```powershell
npm install
npm run dev
```

Useful checks:

```powershell
npm run typecheck
npm test
npm run lint
npm run build
npm run test:e2e
```

Create the Windows NSIS installer with:

```powershell
npm run package:win
```

Application data is stored under Electron's `userData` directory. The selected history window limits the initial import; older pages explicitly requested from a chat remain available locally. Unlinking can retain local history, while **Full fresh reset** removes the account database, encryption key, media, drafts, backups, logs, and preferences before relaunching into onboarding. Downloaded media can be cleared independently from Settings.

## Database backup and recovery

The snapshot command uses SQLite's online backup API, verifies database integrity, copies the DPAPI-protected master key, and writes file hashes plus row counts to `manifest.json`. Keep the complete snapshot directory private because its database and key belong together.

```powershell
$userData = "$env:APPDATA\warish"
$backupRoot = "$env:APPDATA\WArish Upgrade Backups"
node scripts/snapshot-database.mjs "$userData\warish.sqlite" "$userData\master-key.bin" "$backupRoot"
```

Fully close WArish before restoring. Supply the timestamped snapshot directory printed by the backup command:

```powershell
node scripts/restore-database.mjs "<snapshot-directory>" "$userData" "$backupRoot"
```

Restore verifies the manifest before changing live data, moves the current database, WAL, shared-memory file, and key into a timestamped rollback directory, then verifies the recovered database. If recovery fails, it restores those live files automatically.

## Production notes

- Pin Baileys and test upgrades with a secondary number before release. The dependency is deliberately pinned to an exact release candidate.
- Add a signed `.ico` and Windows code-signing configuration before distributing installers.
- Use the verified snapshot workflow above before schema migrations once real accounts are used.
- Review WhatsApp's terms and applicable privacy/data-retention requirements before exposing this to other users.
